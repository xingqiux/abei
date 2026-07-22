<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use Carbon\Carbon;
use FireflyIII\Models\BillArtifact;
use FireflyIII\Models\BillStatementImport;
use Illuminate\Support\Facades\Storage;


class BocStatementImportService
{
    public function __construct(private readonly BillStatementRowIdentityService $rowIdentityService) {}

    public function importExtractedText(BillArtifact $artifact, string $text): BillStatementImport
    {
        $artifact->loadMissing('billTask');
        $existing = $artifact->statementImport;
        if ($existing instanceof BillStatementImport) {
            return $existing;
        }

        $parsed = $this->parse($text);
        $this->archiveArtifact($artifact, $parsed);

        $import = BillStatementImport::query()->create([
            'user_id'           => $artifact->billTask->user_id,
            'bill_task_id'      => $artifact->bill_task_id,
            'bill_artifact_id'  => $artifact->id,
            'source'            => 'boc',
            'profile_id'        => 'boc-transaction-statement',
            'original_filename' => $artifact->metadata['original_name'] ?? $artifact->filename,
            'archived_filename' => (string) $artifact->filename,
            'exported_at'       => $parsed['exported_at'],
            'period_start'      => $parsed['period_start'],
            'period_end'        => $parsed['period_end'],
            'row_count'         => count($parsed['rows']),
            'status'            => 'parsed',
            'metadata'          => [
                'account_no'     => $parsed['account_no'],
                'card_no'        => $parsed['card_no'],
                'format'         => 'pdf_text',
                'text_extractor' => $artifact->metadata['text_extractor'] ?? 'pdftotext-layout',
            ],
        ]);

        foreach ($parsed['rows'] as $index => $row) {
            $this->rowIdentityService->upsertRow($import, $this->rowAttributes($import, $parsed, $row, $index + 1));
        }

        return $import;
    }

    /**
     * @return array{
     *   exported_at:null|Carbon,
     *   period_start:null|Carbon,
     *   period_end:null|Carbon,
     *   archived_filename:string,
     *   account_no:null|string,
     *   card_no:null|string,
     *   rows:array<int,array<string,string>>
     * }
     */
    public function parse(string $text): array
    {
        $text           = str_replace(["\r\n", "\r"], "\n", $text);
        $lines          = explode("\n", $text);
        [$start, $end]  = $this->parsePeriod($text);
        $exportedAt     = $this->parseExportedAt($text);
        $accountNo      = $this->parseAccountNo($text);
        $cardNo         = $this->parseCardNo($text);

        return [
            'exported_at'       => $exportedAt,
            'period_start'      => $start,
            'period_end'        => $end,
            'archived_filename' => $this->archivedFilename($exportedAt, $start, $end),
            'account_no'        => $accountNo,
            'card_no'           => $cardNo,
            'rows'              => $this->parseRows($lines),
        ];
    }

    /**
     * @param array<int,string> $lines
     *
     * @return array<int,array<string,string>>
     */
    private function parseRows(array $lines): array
    {
        $rows         = [];
        $currentIndex = null;

        foreach ($lines as $line) {
            $line = rtrim($line);
            if ('' === trim($line)) {
                $currentIndex = null;

                continue;
            }
            if ($this->isHeaderOrFooterLine($line)) {
                $currentIndex = null;

                continue;
            }

            if (1 === preg_match('/^\s*(20\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(\S+)\s+(-?[0-9,]+\.\d{2})\s+(-?[0-9,]+\.\d{2})\s+(.+)$/u', $line, $matches)) {
                $tail = trim($matches[6]);
                $row  = $this->parseTail($tail);

                $rows[] = $row + [
                    '记账日期' => $matches[1],
                    '记账时间' => $matches[2],
                    '币别'    => $matches[3],
                    '金额'    => str_replace(',', '', $matches[4]),
                    '余额'    => str_replace(',', '', $matches[5]),
                    '原始尾部' => $tail,
                ];
                $currentIndex = count($rows) - 1;

                continue;
            }

            if (null !== $currentIndex) {
                $continuation = $this->continuationColumns($line);
                if ([] !== $continuation) {
                    $rows[$currentIndex] = $this->mergeContinuation($rows[$currentIndex], $continuation);
                }
            }
        }

        return array_values(array_filter($rows, static fn (array $row): bool => '' !== ($row['记账日期'] ?? '')));
    }

    /**
     * @return array<string,string>
     */
    private function parseTail(string $tail): array
    {
        $parts = preg_split('/\s{2,}/u', $tail);
        if (false === $parts) {
            $parts = [];
        }
        $parts = array_values(array_filter(array_map(fn (string $part): string => $this->clean($part), $parts), static fn (string $part): bool => '' !== $part));

        $transactionName = $parts[0] ?? '';
        $channel         = $parts[1] ?? '';
        $branchName      = $parts[2] ?? '';
        $postscript      = $parts[3] ?? '';
        $counterparty    = $parts[4] ?? '';
        $counterAccount  = $parts[5] ?? '';
        $counterBank     = $this->clean(implode(' ', array_slice($parts, 6)));

        if (str_starts_with($branchName, '------------------- ')) {
            $inline = $this->splitInlinePlaceholderColumns($branchName);
            if (null !== $inline) {
                $branchName     = '-------------------';
                $postscript     = $inline[0];
                $counterparty   = $inline[1];
                $counterAccount = $parts[3] ?? '';
                $counterBank    = $this->clean(implode(' ', array_slice($parts, 4)));
            }
        }
        if (str_contains($counterBank, '-------------------')) {
            $counterBank = '';
        }

        return [
            '交易名称'    => $transactionName,
            '渠道'        => $channel,
            '网点名称'    => $branchName,
            '附言'        => $postscript,
            '对方账户名'  => $counterparty,
            '对方卡号/账号'=> $counterAccount,
            '对方开户行'  => $counterBank,
        ];
    }

    /**
     * @param array<string,mixed> $parsed
     * @param array<string,string> $row
     *
     * @return array<string,mixed>
     */
    private function rowAttributes(BillStatementImport $import, array $parsed, array $row, int $rowNumber): array
    {
        $occurredAt   = Carbon::parse($row['记账日期'].' '.$row['记账时间'], 'Asia/Shanghai');
        $signedAmount = $this->clean($row['金额'] ?? '');
        $amount       = ltrim($signedAmount, '+-');
        $direction    = str_starts_with($signedAmount, '-') ? '支出' : '收入';
        $fireflyType  = '支出' === $direction ? 'withdrawal' : 'deposit';
        $category     = $this->clean($row['交易名称'] ?? '');
        $counterparty = $this->clean($row['对方账户名'] ?? '');
        $accountName  = $this->accountName($parsed['card_no'] ?? null);
        $description  = $this->clean($row['附言'] ?? '');
        if ('' === $description || '0' === $description) {
            $description = $category;
        }

        $editable = [
            '记账日期'     => $row['记账日期'],
            '记账时间'     => $row['记账时间'],
            '币别'         => $this->clean($row['币别'] ?? '人民币'),
            '金额'         => $amount,
            '余额'         => $this->clean($row['余额'] ?? ''),
            '交易名称'     => $category,
            '渠道'         => $this->clean($row['渠道'] ?? ''),
            '网点名称'     => $this->clean($row['网点名称'] ?? ''),
            '附言'         => $description,
            '对方账户名'   => $counterparty,
            '对方卡号/账号'=> $this->clean($row['对方卡号/账号'] ?? ''),
            '对方开户行'   => $this->clean($row['对方开户行'] ?? ''),
            '收/支'        => $direction,
        ];

        return [
            'user_id'                  => $import->user_id,
            'bill_task_id'             => $import->bill_task_id,
            'bill_statement_import_id' => $import->id,
            'row_number'               => $rowNumber,
            'status'                   => 'pending',
            'occurred_at'              => $occurredAt,
            'platform_category'        => $category,
            'counterparty'             => $counterparty,
            'counterparty_account'     => $editable['对方卡号/账号'],
            'description'              => $description,
            'direction'                => $direction,
            'amount'                   => $amount,
            'payment_method'           => $accountName,
            'transaction_status'       => null,
            'platform_order_no'        => null,
            'merchant_order_no'        => null,
            'remark'                   => $description,
            'raw_data'                 => $row,
            'editable_data'            => $editable,
            'firefly_type'             => $fireflyType,
            'firefly_date'             => $occurredAt,
            'firefly_amount'           => $amount,
            'firefly_description'      => '' === $counterparty ? $description : $counterparty,
            'source_name'              => 'withdrawal' === $fireflyType ? $accountName : $counterparty,
            'destination_name'         => 'withdrawal' === $fireflyType ? $counterparty : $accountName,
            'category_name'            => $category,
            'notes'                    => sprintf('中国银行交易名称：%s；附言：%s', $category, $description),
            'tags'                     => ['中国银行'],
            'metadata'                 => [
                'balance'      => $editable['余额'],
                'channel'      => $editable['渠道'],
                'counter_bank' => $editable['对方开户行'],
            ],
        ];
    }

    /**
     * @param array{
     *   archived_filename:string,
     *   exported_at:null|Carbon,
     *   period_start:null|Carbon,
     *   period_end:null|Carbon
     * } $parsed
     */
    private function archiveArtifact(BillArtifact $artifact, array $parsed): void
    {
        $oldPath  = (string) $artifact->path;
        $filename = $parsed['archived_filename'];
        $newPath  = sprintf('bill-inbox/%d/derived/%s', $artifact->bill_task_id, $filename);

        if ($oldPath !== $newPath && '' !== $oldPath && Storage::disk('local')->exists($oldPath)) {
            Storage::disk('local')->move($oldPath, $newPath);
        }

        $metadata                         = is_array($artifact->metadata) ? $artifact->metadata : [];
        $metadata['archived_name']         = $filename;
        $metadata['statement_exported_at'] = $parsed['exported_at']?->toAtomString();
        $metadata['statement_period']      = [
            'start' => $parsed['period_start']?->toDateString(),
            'end'   => $parsed['period_end']?->toDateString(),
        ];
        $metadata['parser_status']         = 'parsed';

        $artifact->filename = $filename;
        $artifact->path     = $newPath;
        $artifact->metadata = $metadata;
        $artifact->save();
    }

    /**
     * @return array{0:null|Carbon,1:null|Carbon}
     */
    private function parsePeriod(string $text): array
    {
        if (1 !== preg_match('/交易区间：\s*(20\d{2}-\d{2}-\d{2})\s+至\s+(20\d{2}-\d{2}-\d{2})/u', $text, $matches)) {
            return [null, null];
        }

        return [
            Carbon::parse($matches[1], 'Asia/Shanghai')->startOfDay(),
            Carbon::parse($matches[2], 'Asia/Shanghai')->startOfDay(),
        ];
    }

    private function parseExportedAt(string $text): ?Carbon
    {
        if (1 !== preg_match('/打印时间：\s*(20\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2}:\d{2})/u', $text, $matches)) {
            return null;
        }

        return Carbon::parse(sprintf('%s-%s-%s %s', $matches[1], $matches[2], $matches[3], $matches[4]), 'Asia/Shanghai');
    }

    private function parseAccountNo(string $text): ?string
    {
        if (1 !== preg_match('/账号：\s*([0-9*]+)/u', $text, $matches)) {
            return null;
        }

        return $matches[1];
    }

    private function parseCardNo(string $text): ?string
    {
        if (1 !== preg_match('/借记卡号：\s*([0-9*]+)/u', $text, $matches)) {
            return null;
        }

        return $matches[1];
    }

    private function archivedFilename(?Carbon $exportedAt, ?Carbon $start, ?Carbon $end): string
    {
        $export = $exportedAt?->format('YmdHi') ?? Carbon::now('Asia/Shanghai')->format('YmdHi');
        $period = sprintf('%s_%s', $start?->format('Ymd') ?? 'unknown', $end?->format('Ymd') ?? 'unknown');

        return sprintf('boc-transaction-%s-%s.txt', $export, $period);
    }

    private function accountName(?string $cardNo): string
    {
        $tail = null === $cardNo ? '' : substr($cardNo, -4);

        return '' === $tail ? '中国银行借记卡' : sprintf('中国银行借记卡(%s)', $tail);
    }

    /**
     * @return array<int,string>
     */
    private function continuationColumns(string $line): array
    {
        $value = trim($line);
        if ('' === $value || $this->isHeaderOrFooterLine($value)) {
            return [];
        }

        $parts = preg_split('/\s{2,}/u', $value);
        if (false === $parts) {
            $parts = [];
        }

        return array_values(array_filter(array_map(fn (string $part): string => $this->clean($part), $parts), static fn (string $part): bool => '' !== $part));
    }

    /**
     * @param array<string,string> $row
     * @param array<int,string>    $parts
     *
     * @return array<string,string>
     */
    private function mergeContinuation(array $row, array $parts): array
    {
        if (2 === count($parts)) {
            $row['附言']       = $this->clean(($row['附言'] ?? '').$parts[0]);
            $row['对方账户名'] = $this->clean(($row['对方账户名'] ?? '').$parts[1]);

            return $row;
        }

        $row['对方开户行'] = $this->clean(($row['对方开户行'] ?? '').implode('', $parts));

        return $row;
    }

    /**
     * @return null|array{0:string,1:string}
     */
    private function splitInlinePlaceholderColumns(string $value): ?array
    {
        $value = trim(substr($value, strlen('------------------- ')));
        if ('' === $value) {
            return null;
        }

        $parts = preg_split('/\s+/u', $value);
        if (false === $parts) {
            $parts = [];
        }
        if (count($parts) < 2) {
            return null;
        }

        return [$this->clean($parts[0]), $this->clean($parts[1])];
    }

    private function isHeaderOrFooterLine(string $line): bool
    {
        $value = trim($line);

        return '' === $value
            || str_contains($value, '中国银行交易流水明细清单')
            || str_contains($value, '交易区间')
            || str_contains($value, '借记卡号')
            || str_contains($value, '账号：')
            || str_contains($value, '记账日期')
            || str_contains($value, '--------------------END')
            || str_contains($value, '温馨提示')
            || str_contains($value, '第 ')
        ;
    }

    private function clean(string $value): string
    {
        return trim(preg_replace('/\s+/u', ' ', str_replace("\t", ' ', $value)) ?? $value);
    }
}
