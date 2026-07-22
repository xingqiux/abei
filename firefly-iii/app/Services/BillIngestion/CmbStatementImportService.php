<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use Carbon\Carbon;
use FireflyIII\Models\BillArtifact;
use FireflyIII\Models\BillStatementImport;
use Illuminate\Support\Facades\Storage;
use RuntimeException;
use Symfony\Component\Process\Process;

class CmbStatementImportService
{
    public function __construct(private readonly BillStatementRowIdentityService $rowIdentityService) {}

    public function importArtifact(BillArtifact $artifact): BillStatementImport
    {
        if (null === $artifact->path || '' === $artifact->path) {
            throw new RuntimeException('招商银行账单 PDF 缺少存储路径。');
        }
        if (!Storage::disk('local')->exists($artifact->path)) {
            throw new RuntimeException('招商银行账单 PDF 文件不存在。');
        }

        return $this->importExtractedText($artifact, $this->extractPdfText(Storage::disk('local')->path($artifact->path)));
    }

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
            'source'            => 'cmb',
            'profile_id'        => 'cmb-transaction-statement',
            'original_filename' => $artifact->metadata['original_name'] ?? $artifact->filename,
            'archived_filename' => (string) $artifact->filename,
            'exported_at'       => $parsed['exported_at'],
            'period_start'      => $parsed['period_start'],
            'period_end'        => $parsed['period_end'],
            'row_count'         => count($parsed['rows']),
            'status'            => 'parsed',
            'metadata'          => [
                'account_no'         => $parsed['account_no'],
                'verification_code'  => $parsed['verification_code'],
                'format'             => 'pdf',
                'text_extractor'     => 'pdftotext-layout',
            ],
        ]);

        foreach ($parsed['rows'] as $index => $row) {
            $this->rowIdentityService->upsertRow($import, $this->rowAttributes($import, $row, $index + 1));
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
     *   verification_code:null|string,
     *   rows:array<int,array<string,string>>
     * }
     */
    public function parse(string $text): array
    {
        $text             = str_replace(["\r\n", "\r"], "\n", $text);
        $lines            = explode("\n", $text);
        [$start, $end]    = $this->parsePeriod($text);
        $exportedAt       = $this->parseExportedAt($text);
        $accountNo        = $this->parseAccountNo($text);
        $verificationCode = $this->parseVerificationCode($text);

        return [
            'exported_at'       => $exportedAt,
            'period_start'      => $start,
            'period_end'        => $end,
            'archived_filename' => $this->archivedFilename($exportedAt, $start, $end),
            'account_no'        => $accountNo,
            'verification_code' => $verificationCode,
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
        $rows              = [];
        $pendingBeforeText = [];
        $currentIndex      = null;

        foreach ($lines as $line) {
            $line = rtrim($line);
            if ('' === trim($line)) {
                $currentIndex = null;

                continue;
            }
            if ($this->isPageOrHeaderLine($line)) {
                $currentIndex      = null;
                $pendingBeforeText = [];

                continue;
            }

            if (1 === preg_match('/^(20\d{2}-\d{2}-\d{2})\s+CNY\s+([+-]?[0-9,]+\.\d{2})\s+([+-]?[0-9,]+\.\d{2})\s+(\S(?:.*?\S)?)\s{2,}(\S.*?)\s*$/u', $line, $matches)) {
                $rows[] = [
                    '记账日期' => $matches[1],
                    '货币'    => 'CNY',
                    '交易金额' => str_replace(',', '', $matches[2]),
                    '联机余额' => str_replace(',', '', $matches[3]),
                    '交易摘要' => $this->clean($matches[4]),
                    '对手信息' => $this->clean(implode('', array_merge($pendingBeforeText, [$matches[5]]))),
                ];
                $pendingBeforeText = [];
                $currentIndex      = count($rows) - 1;

                continue;
            }

            if (1 === preg_match('/^(20\d{2}-\d{2}-\d{2})\s+CNY\s+([+-]?[0-9,]+\.\d{2})\s+([+-]?[0-9,]+\.\d{2})\s+(.+?)\s*$/u', $line, $matches)) {
                $rows[] = [
                    '记账日期' => $matches[1],
                    '货币'    => 'CNY',
                    '交易金额' => str_replace(',', '', $matches[2]),
                    '联机余额' => str_replace(',', '', $matches[3]),
                    '交易摘要' => $this->clean($matches[4]),
                    '对手信息' => $this->clean(implode('', $pendingBeforeText)),
                ];
                $pendingBeforeText = [];
                $currentIndex      = count($rows) - 1;

                continue;
            }

            $continuation = $this->continuationText($line);
            if (null === $continuation) {
                continue;
            }

            if (null !== $currentIndex && '' !== ($rows[$currentIndex]['对手信息'] ?? '')) {
                $rows[$currentIndex]['对手信息'] = $this->clean($rows[$currentIndex]['对手信息'].$continuation);
                continue;
            }
            $pendingBeforeText[] = $continuation;
        }

        return array_values(array_filter($rows, static fn (array $row): bool => '' !== ($row['记账日期'] ?? '')));
    }

    /**
     * @param array<string,string> $row
     *
     * @return array<string,mixed>
     */
    private function rowAttributes(BillStatementImport $import, array $row, int $rowNumber): array
    {
        $occurredAt   = Carbon::parse($row['记账日期'], 'Asia/Shanghai')->startOfDay();
        $signedAmount = $this->clean($row['交易金额'] ?? '');
        $amount       = ltrim($signedAmount, '+-');
        $direction    = str_starts_with($signedAmount, '-') ? '支出' : '收入';
        $fireflyType  = '支出' === $direction ? 'withdrawal' : 'deposit';
        $summary      = $this->clean($row['交易摘要'] ?? '');
        $counterparty = $this->clean($row['对手信息'] ?? '');
        $accountName  = '招商银行储蓄卡(8705)';

        $editable = [
            '记账日期' => $row['记账日期'],
            '货币'    => $this->clean($row['货币'] ?? 'CNY'),
            '交易金额' => $amount,
            '联机余额' => $this->clean($row['联机余额'] ?? ''),
            '交易摘要' => $summary,
            '对手信息' => $counterparty,
            '收/支'   => $direction,
        ];

        return [
            'user_id'                  => $import->user_id,
            'bill_task_id'             => $import->bill_task_id,
            'bill_statement_import_id' => $import->id,
            'row_number'               => $rowNumber,
            'status'                   => 'pending',
            'occurred_at'              => $occurredAt,
            'platform_category'        => $summary,
            'counterparty'             => $counterparty,
            'counterparty_account'     => null,
            'description'              => $summary,
            'direction'                => $direction,
            'amount'                   => $amount,
            'payment_method'           => $accountName,
            'transaction_status'       => null,
            'platform_order_no'        => null,
            'merchant_order_no'        => null,
            'remark'                   => null,
            'raw_data'                 => $row,
            'editable_data'            => $editable,
            'firefly_type'             => $fireflyType,
            'firefly_date'             => $occurredAt,
            'firefly_amount'           => $amount,
            'firefly_description'      => '' === $counterparty ? $summary : $counterparty,
            'source_name'              => 'withdrawal' === $fireflyType ? $accountName : $counterparty,
            'destination_name'         => 'withdrawal' === $fireflyType ? $counterparty : $accountName,
            'category_name'            => $summary,
            'notes'                    => sprintf('招商银行交易摘要：%s', $summary),
            'tags'                     => ['招商银行'],
            'metadata'                 => [
                'balance' => $editable['联机余额'],
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

    private function extractPdfText(string $path): string
    {
        $process = new Process(['pdftotext', '-layout', $path, '-']);
        $process->run();
        if (!$process->isSuccessful()) {
            throw new RuntimeException('招商银行账单 PDF 文本提取失败。');
        }

        return $process->getOutput();
    }

    /**
     * @return array{0:null|Carbon,1:null|Carbon}
     */
    private function parsePeriod(string $text): array
    {
        if (1 !== preg_match('/(20\d{2}-\d{2}-\d{2})\s+--\s+(20\d{2}-\d{2}-\d{2})/u', $text, $matches)) {
            return [null, null];
        }

        return [
            Carbon::parse($matches[1], 'Asia/Shanghai')->startOfDay(),
            Carbon::parse($matches[2], 'Asia/Shanghai')->startOfDay(),
        ];
    }

    private function parseExportedAt(string $text): ?Carbon
    {
        if (1 !== preg_match('/申请时间：\s*(20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/u', $text, $matches)) {
            return null;
        }

        return Carbon::parse($matches[1], 'Asia/Shanghai');
    }

    private function parseAccountNo(string $text): ?string
    {
        if (1 !== preg_match('/账号：\s*([0-9*]+)/u', $text, $matches)) {
            return null;
        }

        return $matches[1];
    }

    private function parseVerificationCode(string $text): ?string
    {
        if (1 !== preg_match('/验\s*证\s*码：\s*([A-Z0-9]+)/u', $text, $matches)) {
            return null;
        }

        return $matches[1];
    }

    private function archivedFilename(?Carbon $exportedAt, ?Carbon $start, ?Carbon $end): string
    {
        $export = $exportedAt?->format('YmdHi') ?? Carbon::now('Asia/Shanghai')->format('YmdHi');
        $period = sprintf('%s_%s', $start?->format('Ymd') ?? 'unknown', $end?->format('Ymd') ?? 'unknown');

        return sprintf('cmb-transaction-%s-%s.pdf', $export, $period);
    }

    private function continuationText(string $line): ?string
    {
        $value = trim($line);
        if ('' === $value) {
            return null;
        }
        if (preg_match('/^(招商银行交易流水|Transaction Statement|户\s*名|Name|账户类型|Account Type|申请时间|Date|记账日期|Date\s+Currency|Transaction|Amount|温馨提示|和“明细项|—|1\.)/u', $value)) {
            return null;
        }
        if (preg_match('/^\d+\/\d+$/', $value)) {
            return null;
        }
        if (preg_match('/^20\d{2}-\d{2}-\d{2}\s+--\s+20\d{2}-\d{2}-\d{2}$/', $value)) {
            return null;
        }

        return $this->clean($value);
    }

    private function isPageOrHeaderLine(string $line): bool
    {
        $value = trim($line);

        return '' === $value
            || preg_match('/^\d+\/\d+$/', $value)
            || preg_match('/^20\d{2}-\d{2}-\d{2}\s+--\s+20\d{2}-\d{2}-\d{2}$/', $value)
            || str_contains($value, '记账日期')
            || str_contains($value, 'Transaction')
            || str_contains($value, 'Currency')
            || str_contains($value, 'Amount')
            || str_contains($value, 'Counter Party')
            || str_contains($value, '温馨提示')
            || str_contains($value, '招商银行交易流水')
            || str_contains($value, 'Transaction Statement of China Merchants Bank')
            || str_contains($value, '户      名')
            || str_contains($value, 'Name')
            || str_contains($value, '账户类型')
            || str_contains($value, 'Account Type')
            || str_contains($value, '申请时间')
            || str_contains($value, 'Verification Code');
    }

    private function clean(string $value): string
    {
        return trim(preg_replace('/\s+/u', ' ', str_replace("\t", ' ', $value)) ?? $value);
    }
}
