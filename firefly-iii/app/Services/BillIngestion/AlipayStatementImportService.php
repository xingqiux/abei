<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use Carbon\Carbon;
use FireflyIII\Models\BillArtifact;
use FireflyIII\Models\BillStatementImport;
use Illuminate\Support\Facades\Storage;
use RuntimeException;

class AlipayStatementImportService
{
    private const array REQUIRED_COLUMNS = [
        '交易时间',
        '交易分类',
        '交易对方',
        '对方账号',
        '商品说明',
        '收/支',
        '金额',
        '收/付款方式',
        '交易状态',
        '交易订单号',
        '商家订单号',
        '备注',
    ];

    public function __construct(private readonly BillStatementRowIdentityService $rowIdentityService) {}

    public function importArtifact(BillArtifact $artifact, string $content): BillStatementImport
    {
        $artifact->loadMissing('billTask');
        $existing = $artifact->statementImport;
        if ($existing instanceof BillStatementImport) {
            return $existing;
        }

        $parsed = $this->parse($content);
        $this->archiveArtifact($artifact, $parsed);

        $import = BillStatementImport::query()->create([
            'user_id'           => $artifact->billTask->user_id,
            'bill_task_id'      => $artifact->bill_task_id,
            'bill_artifact_id'  => $artifact->id,
            'source'            => 'alipay',
            'profile_id'        => 'alipay-statement',
            'original_filename' => $artifact->metadata['original_name'] ?? $artifact->filename,
            'archived_filename' => (string) $artifact->filename,
            'exported_at'       => $parsed['exported_at'],
            'period_start'      => $parsed['period_start'],
            'period_end'        => $parsed['period_end'],
            'row_count'         => count($parsed['rows']),
            'status'            => 'parsed',
            'metadata'          => [
                'header_row' => $parsed['header_row'],
                'encoding'    => $parsed['encoding'],
            ],
        ]);

        foreach ($parsed['rows'] as $index => $row) {
            $this->rowIdentityService->upsertRow($import, $this->rowAttributes($import, $row, $index + 1));
        }

        return $import;
    }

    /**
     * @return array{
     *   encoding:string,
     *   exported_at:null|Carbon,
     *   period_start:null|Carbon,
     *   period_end:null|Carbon,
     *   archived_filename:string,
     *   header_row:int,
     *   rows:array<int,array<string,string>>
     * }
     */
    public function parse(string $content): array
    {
        $encoding = mb_detect_encoding($content, ['UTF-8', 'GB18030', 'GBK', 'BIG5'], true);
        if (false === $encoding) {
            $encoding = 'GB18030';
        }
        $text     = 'UTF-8' === $encoding ? $content : mb_convert_encoding($content, 'UTF-8', $encoding);
        $text     = str_replace("\r\n", "\n", $text);
        $text     = str_replace("\r", "\n", $text);

        $lines       = explode("\n", $text);
        $exportedAt  = $this->parseExportedAt($lines);
        [$start, $end] = $this->parsePeriod($lines);
        [$headerIndex, $header] = $this->findHeader($lines);
        $rows        = $this->parseRows(array_slice($lines, $headerIndex + 1), $header);

        return [
            'encoding'           => $encoding,
            'exported_at'        => $exportedAt,
            'period_start'       => $start,
            'period_end'         => $end,
            'archived_filename'  => $this->archivedFilename($exportedAt, $start, $end),
            'header_row'         => $headerIndex + 1,
            'rows'               => $rows,
        ];
    }

    /**
     * @param array<string,string> $row
     *
     * @return array<string,mixed>
     */
    private function rowAttributes(BillStatementImport $import, array $row, int $rowNumber): array
    {
        $occurredAt     = $this->parseDateTime($row['交易时间'] ?? '');
        $direction      = $this->clean($row['收/支'] ?? '');
        $amount         = $this->clean($row['金额'] ?? '');
        $paymentMethod  = $this->clean($row['收/付款方式'] ?? '');
        $counterparty   = $this->clean($row['交易对方'] ?? '');
        $description    = $this->clean($row['商品说明'] ?? '');
        $platformOrder  = $this->clean($row['交易订单号'] ?? '');
        $merchantOrder  = $this->clean($row['商家订单号'] ?? '');
        $flowType       = $this->fireflyType($direction);
        $fireflyType    = $flowType;
        $paymentSplit   = $this->paymentSplit($paymentMethod);
        if (null !== $paymentSplit) {
            $fireflyType = null;
        }
        $sourceName     = null;
        $destinationName = null;
        if ('withdrawal' === $flowType) {
            $sourceName      = null === $paymentSplit ? $this->fireflyAccountName($paymentMethod) : null;
            $destinationName = $counterparty;
        }
        if ('deposit' === $flowType) {
            $sourceName      = $counterparty;
            $destinationName = null === $paymentSplit ? $this->fireflyAccountName($paymentMethod) : null;
        }

        $editable = [
            '交易时间'   => $this->clean($row['交易时间'] ?? ''),
            '交易分类'   => $this->clean($row['交易分类'] ?? ''),
            '交易对方'   => $counterparty,
            '对方账号'   => $this->clean($row['对方账号'] ?? ''),
            '商品说明'   => $description,
            '收/支'      => $direction,
            '金额'       => $amount,
            '收/付款方式' => $paymentMethod,
            '交易状态'   => $this->clean($row['交易状态'] ?? ''),
            '交易订单号' => $platformOrder,
            '商家订单号' => $merchantOrder,
            '备注'       => $this->clean($row['备注'] ?? ''),
        ];

        return [
            'user_id'                    => $import->user_id,
            'bill_task_id'               => $import->bill_task_id,
            'bill_statement_import_id'   => $import->id,
            'row_number'                 => $rowNumber,
            'status'                     => null === $paymentSplit ? 'pending' : 'needs_split',
            'occurred_at'                => $occurredAt,
            'platform_category'          => $editable['交易分类'],
            'counterparty'               => $counterparty,
            'counterparty_account'       => $editable['对方账号'],
            'description'                => $description,
            'direction'                  => $direction,
            'amount'                     => '' === $amount ? null : $amount,
            'payment_method'             => $paymentMethod,
            'transaction_status'         => $editable['交易状态'],
            'platform_order_no'          => $platformOrder,
            'merchant_order_no'          => $merchantOrder,
            'remark'                     => $editable['备注'],
            'raw_data'                   => $row,
            'editable_data'              => $editable,
            'firefly_type'               => $fireflyType,
            'firefly_date'               => $occurredAt,
            'firefly_amount'             => null === $paymentSplit && '' !== $amount ? $amount : null,
            'firefly_description'        => '' === $description ? $counterparty : $description,
            'source_name'                => $sourceName,
            'destination_name'           => $destinationName,
            'category_name'              => $editable['交易分类'],
            'notes'                      => $this->notes($platformOrder, $merchantOrder),
            'tags'                       => ['支付宝'],
            'metadata'                   => null === $paymentSplit ? [] : ['payment_split' => $paymentSplit],
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

        $artifact->filename = $filename;
        $artifact->path     = $newPath;
        $artifact->metadata = $metadata;
        $artifact->save();
    }

    /**
     * @param array<int,string> $lines
     */
    private function parseExportedAt(array $lines): ?Carbon
    {
        foreach ($lines as $line) {
            if (1 === preg_match('/导出时间：\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/u', $line, $matches)) {
                return Carbon::parse($matches[1], 'Asia/Shanghai');
            }
        }

        return null;
    }

    /**
     * @param array<int,string> $lines
     *
     * @return array{0:null|Carbon,1:null|Carbon}
     */
    private function parsePeriod(array $lines): array
    {
        foreach ($lines as $line) {
            if (1 === preg_match('/起始时间：\[(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}\]\s+终止时间：\[(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}\]/u', $line, $matches)) {
                return [
                    Carbon::parse($matches[1], 'Asia/Shanghai')->startOfDay(),
                    Carbon::parse($matches[2], 'Asia/Shanghai')->startOfDay(),
                ];
            }
        }

        return [null, null];
    }

    /**
     * @param array<int,string> $lines
     *
     * @return array{0:int,1:array<int,string>}
     */
    private function findHeader(array $lines): array
    {
        foreach ($lines as $index => $line) {
            $columns = $this->parseLine($line);
            if ($this->hasRequiredColumns($columns)) {
                return [$index, $columns];
            }
        }

        throw new RuntimeException('支付宝账单缺少交易明细表头。');
    }

    /**
     * @param array<int,string> $lines
     * @param array<int,string> $header
     *
     * @return array<int,array<string,string>>
     */
    private function parseRows(array $lines, array $header): array
    {
        $rows = [];
        foreach ($lines as $line) {
            if ('' === trim($line)) {
                continue;
            }
            $values = $this->parseLine($line);
            if (count($values) < count($header)) {
                continue;
            }
            $row = [];
            foreach ($header as $index => $column) {
                $row[$column] = $this->clean($values[$index] ?? '');
            }
            if ('' === ($row['交易时间'] ?? '')) {
                continue;
            }
            $rows[] = $row;
        }

        return $rows;
    }

    /**
     * @return array<int,string>
     */
    private function parseLine(string $line): array
    {
        if (str_contains($line, ',')) {
            return array_map(fn (string $value): string => $this->clean($value), str_getcsv($line));
        }

        return array_values(array_filter(array_map(
            fn (string $value): string => $this->clean($value),
            explode('|', $line)
        ), static fn (string $value): bool => '' !== $value));
    }

    /**
     * @param array<int,string> $columns
     */
    private function hasRequiredColumns(array $columns): bool
    {
        foreach (self::REQUIRED_COLUMNS as $column) {
            if (!in_array($column, $columns, true)) {
                return false;
            }
        }

        return true;
    }

    private function archivedFilename(?Carbon $exportedAt, ?Carbon $start, ?Carbon $end): string
    {
        $export = $exportedAt?->format('YmdHi') ?? Carbon::now('Asia/Shanghai')->format('YmdHi');
        $period = sprintf('%s_%s', $start?->format('Ymd') ?? 'unknown', $end?->format('Ymd') ?? 'unknown');

        return sprintf('alipay-%s-%s.csv', $export, $period);
    }

    private function parseDateTime(string $value): ?Carbon
    {
        if ('' === trim($value)) {
            return null;
        }

        return Carbon::parse($value, 'Asia/Shanghai');
    }

    private function fireflyType(string $direction): ?string
    {
        return match ($direction) {
            '支出' => 'withdrawal',
            '收入' => 'deposit',
            default => null,
        };
    }

    private function notes(string $platformOrder, string $merchantOrder): ?string
    {
        $parts = [];
        if ('' !== $platformOrder) {
            $parts[] = sprintf('支付宝交易订单号：%s', $platformOrder);
        }
        if ('' !== $merchantOrder) {
            $parts[] = sprintf('商家订单号：%s', $merchantOrder);
        }

        return [] === $parts ? null : implode("\n", $parts);
    }

    private function fireflyAccountName(string $paymentMethod): string
    {
        $primary = trim(explode('&', $paymentMethod)[0] ?? $paymentMethod);
        if (str_contains($primary, '招商银行')) {
            return '招商银行';
        }
        if (str_contains($primary, '中国银行')) {
            return '中国银行';
        }
        if (str_contains($primary, '花呗')) {
            return '花呗';
        }

        return '' === $primary ? '支付宝' : $primary;
    }

    /**
     * @return null|array{methods:array<int,string>,reason:string}
     */
    private function paymentSplit(string $paymentMethod): ?array
    {
        $methods = array_values(array_filter(
            array_map(fn (string $method): string => $this->clean($method), explode('&', $paymentMethod)),
            fn (string $method): bool => '' !== $method && !$this->isAlipayDiscountMethod($method)
        ));

        if (count($methods) < 2) {
            return null;
        }

        return [
            'methods' => $methods,
            'reason'  => '支付宝组合支付需要先拆分实际扣款账户和金额',
        ];
    }

    private function isAlipayDiscountMethod(string $method): bool
    {
        foreach (['优惠', '立减', '红包', '奖励金', '折扣', '抵扣', '特惠'] as $keyword) {
            if (str_contains($method, $keyword)) {
                return true;
            }
        }

        return false;
    }

    private function clean(string $value): string
    {
        return trim(str_replace("\t", '', $value));
    }
}
