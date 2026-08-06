<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use Carbon\Carbon;
use DOMDocument;
use DOMXPath;
use FireflyIII\Models\BillArtifact;
use FireflyIII\Models\BillStatementImport;
use Illuminate\Support\Facades\Storage;
use RuntimeException;

class CmbCreditDailyImportService
{
    public function __construct(private readonly BillStatementRowIdentityService $rowIdentityService) {}

    public function importArtifact(BillArtifact $artifact): BillStatementImport
    {
        $path = (string) $artifact->path;
        if ('' === $path) {
            throw new RuntimeException('招商银行每日信用管家邮件缺少 HTML 正文。');
        }
        if (!Storage::disk('local')->exists($path)) {
            throw new RuntimeException('招商银行每日信用管家 HTML 正文不存在。');
        }
        $html = Storage::disk('local')->get($path);
        if (!is_string($html)) {
            throw new RuntimeException('招商银行每日信用管家 HTML 正文无法读取。');
        }

        $artifact->loadMissing('billTask.mailMessage');
        $existing = $artifact->statementImport;
        if ($existing instanceof BillStatementImport) {
            return $existing;
        }

        $parsed           = $this->parseHtml($html);
        $metadata         = is_array($artifact->metadata) ? $artifact->metadata : [];
        $originalFilename = $metadata['original_name'] ?? $artifact->filename;
        $archivedFilename = sprintf('cmb-credit-daily-%s.html', $parsed['statement_date']->format('Ymd'));
        $metadata['parser_status'] = 'parsed';
        $artifact->filename         = $archivedFilename;
        $artifact->metadata         = $metadata;
        $artifact->save();

        $import = BillStatementImport::query()->create([
            'user_id'           => $artifact->billTask->user_id,
            'bill_task_id'      => $artifact->bill_task_id,
            'bill_artifact_id'  => $artifact->id,
            'source'            => 'cmb',
            'profile_id'        => 'cmb-credit-card-daily',
            'original_filename' => $originalFilename,
            'archived_filename' => $archivedFilename,
            'exported_at'       => $artifact->billTask->mailMessage?->received_at,
            'period_start'      => $parsed['statement_date'],
            'period_end'        => $parsed['statement_date'],
            'row_count'         => count($parsed['rows']),
            'status'            => 'parsed',
            'metadata'          => [
                'format'   => 'html',
                'timezone' => 'Asia/Shanghai',
            ],
        ]);

        foreach ($parsed['rows'] as $index => $row) {
            $this->rowIdentityService->upsertRow($import, $this->rowAttributes($import, $row, $index + 1));
        }

        return $import;
    }

    /**
     * @return array{
     *   statement_date:Carbon,
     *   rows:array<int,array{交易时间:string,货币:string,交易金额:string,卡尾号:string,交易类型:string,交易对方:string}>
     * }
     */
    public function parseHtml(string $html): array
    {
        $segments      = $this->visibleTextSegments($html);
        $statementDate = null;

        foreach ($segments as $segment) {
            if (1 === preg_match('/\b(20\d{2}\/\d{2}\/\d{2})\b.*消费明细/u', $segment, $matches)) {
                $date = Carbon::createFromFormat('Y/m/d', $matches[1], 'Asia/Shanghai');
                if ($date instanceof Carbon) {
                    $statementDate = $date->startOfDay();
                    break;
                }
            }
        }
        if (!$statementDate instanceof Carbon) {
            throw new RuntimeException('招商银行每日信用管家邮件缺少消费日期。');
        }

        $rows = [];
        for ($index = 0, $count = count($segments); $index < $count; ++$index) {
            if (1 !== preg_match('/^(\d{2}:\d{2}:\d{2})$/', $segments[$index], $timeMatches)) {
                continue;
            }
            if (1 !== preg_match('/^([A-Z]{3})\s+([0-9][0-9,]*\.\d{2})$/', $segments[$index + 1] ?? '', $amountMatches)
                || 1 !== preg_match('/^尾号(\d{4})\s+(\S+)\s+(.+)$/u', $segments[$index + 2] ?? '', $detailMatches)) {
                throw new RuntimeException('招商银行每日信用管家消费明细结构无法识别。');
            }

            $rows[] = [
                '交易时间' => $statementDate->format('Y-m-d').' '.$timeMatches[1],
                '货币'    => $amountMatches[1],
                '交易金额' => str_replace(',', '', $amountMatches[2]),
                '卡尾号'   => $detailMatches[1],
                '交易类型' => $detailMatches[2],
                '交易对方' => $this->clean($detailMatches[3]),
            ];
            $index += 2;
        }

        if ([] === $rows) {
            throw new RuntimeException('招商银行每日信用管家邮件没有可解析的消费明细。');
        }

        return [
            'statement_date' => $statementDate,
            'rows'           => $rows,
        ];
    }

    /**
     * @param array{交易时间:string,货币:string,交易金额:string,卡尾号:string,交易类型:string,交易对方:string} $row
     *
     * @return array<string,mixed>
     */
    private function rowAttributes(BillStatementImport $import, array $row, int $rowNumber): array
    {
        $occurredAt  = Carbon::parse($row['交易时间'], 'Asia/Shanghai');
        $amount      = $row['交易金额'];
        $accountName = sprintf('招商银行信用卡(%s)', $row['卡尾号']);
        $direction   = match ($row['交易类型']) {
            '消费', '取现' => '支出',
            '退款', '退货' => '收入',
            default        => '不计收支',
        };
        $fireflyType = match ($direction) {
            '支出'  => 'withdrawal',
            '收入'  => 'deposit',
            default => null,
        };
        $counterparty = $row['交易对方'];
        $editable     = $row + ['收/支' => $direction];

        return [
            'user_id'                  => $import->user_id,
            'bill_task_id'             => $import->bill_task_id,
            'bill_statement_import_id' => $import->id,
            'row_number'               => $rowNumber,
            'status'                   => 'pending',
            'occurred_at'              => $occurredAt,
            'platform_category'        => $row['交易类型'],
            'counterparty'             => $counterparty,
            'counterparty_account'     => null,
            'description'              => $counterparty,
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
            'firefly_description'      => $counterparty,
            'source_name'              => 'deposit' === $fireflyType ? $counterparty : $accountName,
            'destination_name'         => 'deposit' === $fireflyType ? $accountName : $counterparty,
            'category_name'            => null,
            'notes'                    => sprintf('招商银行每日信用管家，信用卡尾号%s', $row['卡尾号']),
            'tags'                     => ['招商银行', '信用卡'],
            'metadata'                 => [
                'currency'       => $row['货币'],
                'card_last_four' => $row['卡尾号'],
            ],
        ];
    }

    /**
     * @return array<int,string>
     */
    private function visibleTextSegments(string $html): array
    {
        $document       = new DOMDocument('1.0', 'UTF-8');
        $previousErrors = libxml_use_internal_errors(true);

        try {
            $loaded = $document->loadHTML(
                '<?xml encoding="UTF-8">'.$html,
                LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING | LIBXML_COMPACT
            );
        } finally {
            libxml_clear_errors();
            libxml_use_internal_errors($previousErrors);
        }
        if (false === $loaded) {
            throw new RuntimeException('招商银行每日信用管家 HTML 正文无法读取。');
        }

        $nodes = (new DOMXPath($document))->query('//body//text()[normalize-space() and not(ancestor::script) and not(ancestor::style)]');
        if (false === $nodes) {
            throw new RuntimeException('招商银行每日信用管家 HTML 正文无法读取。');
        }

        $segments = [];
        foreach ($nodes as $node) {
            $value = $this->clean(str_replace("\u{00A0}", ' ', $node->textContent));
            if ('' !== $value) {
                $segments[] = $value;
            }
        }

        return $segments;
    }

    private function clean(string $value): string
    {
        return trim(preg_replace('/\s+/u', ' ', $value) ?? $value);
    }
}
