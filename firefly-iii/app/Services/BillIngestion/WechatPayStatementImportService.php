<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use Carbon\Carbon;
use FireflyIII\Models\BillArtifact;
use FireflyIII\Models\BillStatementImport;
use Illuminate\Support\Facades\Storage;
use RuntimeException;
use ZipArchive;

class WechatPayStatementImportService
{
    private const array REQUIRED_COLUMNS = [
        '交易时间',
        '交易类型',
        '交易对方',
        '商品',
        '收/支',
        '金额(元)',
        '支付方式',
        '当前状态',
        '交易单号',
        '商户单号',
    ];

    public function __construct(private readonly BillStatementRowIdentityService $rowIdentityService) {}

    public function importArtifact(BillArtifact $artifact, string $content): BillStatementImport
    {
        $artifact->loadMissing('billTask');
        $existing = $artifact->statementImport;
        if ($existing instanceof BillStatementImport) {
            $this->fillMissingRows($existing, $this->parse($content));

            return $existing;
        }

        $parsed = $this->parse($content);
        $this->archiveArtifact($artifact, $parsed);

        $import = BillStatementImport::query()->create([
            'user_id'           => $artifact->billTask->user_id,
            'bill_task_id'      => $artifact->bill_task_id,
            'bill_artifact_id'  => $artifact->id,
            'source'            => 'wechat',
            'profile_id'        => 'wechat-pay-statement',
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
                'format'      => $parsed['format'],
            ],
        ]);

        foreach ($parsed['rows'] as $index => $row) {
            $this->rowIdentityService->upsertRow($import, $this->rowAttributes($import, $row, $index + 1));
        }

        return $import;
    }

    /**
     * @param array{rows:array<int,array<string,string>>} $parsed
     */
    private function fillMissingRows(BillStatementImport $import, array $parsed): void
    {
        $existing = $import->rows()->pluck('row_number')->map(static fn (int $row): int => $row)->all();
        foreach ($parsed['rows'] as $index => $row) {
            $rowNumber = $index + 1;
            if (in_array($rowNumber, $existing, true)) {
                continue;
            }
            $this->rowIdentityService->upsertRow($import, $this->rowAttributes($import, $row, $rowNumber));
        }
    }

    /**
     * @return array{format:string, encoding:string, exported_at:null|Carbon, period_start:null|Carbon, period_end:null|Carbon, archived_filename:string, header_row:int, rows:array<int,array<string,string>>}
     */
    public function parse(string $content): array
    {
        if ($this->isXlsx($content)) {
            return $this->parseXlsx($content);
        }

        return $this->parseCsv($content);
    }

    /**
     * @return array{format:string, encoding:string, exported_at:null|Carbon, period_start:null|Carbon, period_end:null|Carbon, archived_filename:string, header_row:int, rows:array<int,array<string,string>>}
     */
    private function parseCsv(string $content): array
    {
        $encoding = mb_detect_encoding($content, ['UTF-8', 'GB18030', 'GBK', 'BIG5'], true);
        if (false === $encoding) {
            $encoding = 'UTF-8';
        }
        $text     = 'UTF-8' === $encoding ? $content : mb_convert_encoding($content, 'UTF-8', $encoding);
        $text     = str_replace(["\r\n", "\r"], "\n", $text);
        $lines    = explode("\n", $text);

        $exportedAt        = $this->parseExportedAt($lines);
        [$start, $end]     = $this->parsePeriod($lines);
        [$headerIndex, $header] = $this->findHeader($lines);

        return [
            'format'            => 'csv',
            'encoding'          => $encoding,
            'exported_at'       => $exportedAt,
            'period_start'      => $start,
            'period_end'        => $end,
            'archived_filename' => $this->archivedFilename($exportedAt, $start, $end, 'csv'),
            'header_row'        => $headerIndex + 1,
            'rows'              => $this->parseRows(array_slice($lines, $headerIndex + 1), $header),
        ];
    }

    /**
     * @return array{format:string, encoding:string, exported_at:null|Carbon, period_start:null|Carbon, period_end:null|Carbon, archived_filename:string, header_row:int, rows:array<int,array<string,string>>}
     */
    private function parseXlsx(string $content): array
    {
        $path = tempnam(sys_get_temp_dir(), 'wechat-pay-xlsx-');
        if (false === $path) {
            throw new RuntimeException('无法创建微信支付账单临时解析文件。');
        }

        file_put_contents($path, $content);

        $zip = new ZipArchive();
        if (true !== $zip->open($path)) {
            unlink($path);

            throw new RuntimeException('无法打开微信支付账单 XLSX 文件。');
        }

        try {
            $sharedStrings = $this->readSharedStrings($zip);
            $table         = $this->readFirstWorksheetTable($zip, $sharedStrings);
        } finally {
            $zip->close();
            unlink($path);
        }

        $summaryLines            = $this->summaryLines($table);
        $exportedAt              = $this->parseExportedAt($summaryLines);
        [$start, $end]           = $this->parsePeriod($summaryLines);
        [$headerIndex, $header]  = $this->findHeaderInTable($table);

        return [
            'format'            => 'xlsx',
            'encoding'          => 'xlsx',
            'exported_at'       => $exportedAt,
            'period_start'      => $start,
            'period_end'        => $end,
            'archived_filename' => $this->archivedFilename($exportedAt, $start, $end, 'xlsx'),
            'header_row'        => $headerIndex + 1,
            'rows'              => $this->parseTableRows(array_slice($table, $headerIndex + 1), $header),
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
        $amount         = $this->clean(str_replace(['¥', '￥'], '', $row['金额(元)'] ?? ''));
        $paymentMethod  = $this->clean($row['支付方式'] ?? '');
        $counterparty   = $this->clean($row['交易对方'] ?? '');
        $description    = $this->clean($row['商品'] ?? '');
        $platformOrder  = $this->clean($row['交易单号'] ?? '');
        $merchantOrder  = $this->clean($row['商户单号'] ?? '');
        $platformCategory = $this->clean($row['交易类型'] ?? '');
        $fireflyType      = $this->fireflyType($direction);
        $categoryName     = $this->categoryName($platformCategory);
        $fireflyDescription = $this->fireflyDescription($description, $counterparty, $direction, $categoryName);
        $sourceName     = null;
        $destinationName = null;
        if ('withdrawal' === $fireflyType) {
            $sourceName      = $this->fireflyAccountName($paymentMethod);
            $destinationName = $counterparty;
        }
        if ('deposit' === $fireflyType) {
            $sourceName      = $counterparty;
            $destinationName = $this->fireflyAccountName($paymentMethod);
        }

        $editable = [
            '交易时间' => $this->clean($row['交易时间'] ?? ''),
            '交易类型' => $this->clean($row['交易类型'] ?? ''),
            '交易对方' => $counterparty,
            '商品'    => $description,
            '收/支'   => $direction,
            '金额(元)' => $amount,
            '支付方式' => $paymentMethod,
            '当前状态' => $this->clean($row['当前状态'] ?? ''),
            '交易单号' => $platformOrder,
            '商户单号' => $merchantOrder,
            '备注'    => $this->clean($row['备注'] ?? ''),
        ];

        return [
            'user_id'                  => $import->user_id,
            'bill_task_id'             => $import->bill_task_id,
            'bill_statement_import_id' => $import->id,
            'row_number'               => $rowNumber,
            'status'                   => 'pending',
            'occurred_at'              => $occurredAt,
            'platform_category'        => $editable['交易类型'],
            'counterparty'             => $counterparty,
            'counterparty_account'     => null,
            'description'              => $description,
            'direction'                => $direction,
            'amount'                   => '' === $amount ? null : $amount,
            'payment_method'           => $paymentMethod,
            'transaction_status'       => $editable['当前状态'],
            'platform_order_no'        => $platformOrder,
            'merchant_order_no'        => $merchantOrder,
            'remark'                   => $editable['备注'],
            'raw_data'                 => $row,
            'editable_data'            => $editable,
            'firefly_type'             => $fireflyType,
            'firefly_date'             => $occurredAt,
            'firefly_amount'           => '' === $amount ? null : $amount,
            'firefly_description'      => $fireflyDescription,
            'source_name'              => $sourceName,
            'destination_name'         => $destinationName,
            'category_name'            => $categoryName,
            'notes'                    => '' === $platformOrder ? null : sprintf('微信支付交易单号：%s', $platformOrder),
            'tags'                     => ['微信支付'],
        ];
    }

    /**
     * @param array{archived_filename:string, exported_at:null|Carbon, period_start:null|Carbon, period_end:null|Carbon} $parsed
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
            if (1 === preg_match('/起始时间：\[(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}\].*?终止时间：\[(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}\]/u', $line, $matches)) {
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

        throw new RuntimeException('微信支付账单缺少交易明细表头。');
    }

    /**
     * @param array<int,array<int,string>> $table
     */
    private function summaryLines(array $table): array
    {
        $lines = [];
        foreach ($table as $row) {
            $line = trim(implode(' ', array_filter($row, static fn (string $value): bool => '' !== trim($value))));
            if ('' !== $line) {
                $lines[] = $line;
            }
        }

        return $lines;
    }

    /**
     * @param array<int,array<int,string>> $table
     *
     * @return array{0:int,1:array<int,string>}
     */
    private function findHeaderInTable(array $table): array
    {
        foreach ($table as $index => $columns) {
            $columns = array_map(fn (string $value): string => $this->clean($value), $columns);
            if ($this->hasRequiredColumns($columns)) {
                return [$index, $columns];
            }
        }

        throw new RuntimeException('微信支付账单 XLSX 缺少交易明细表头。');
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
     * @param array<int,array<int,string>> $table
     * @param array<int,string> $header
     *
     * @return array<int,array<string,string>>
     */
    private function parseTableRows(array $table, array $header): array
    {
        $rows = [];
        foreach ($table as $values) {
            if (count(array_filter($values, static fn (string $value): bool => '' !== trim($value))) < 2) {
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
        return array_map(fn (mixed $value): string => $this->clean((string) $value), str_getcsv($line));
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

    /**
     * @return array<int,string>
     */
    private function readSharedStrings(ZipArchive $zip): array
    {
        $xml = $zip->getFromName('xl/sharedStrings.xml');
        if (false === $xml) {
            return [];
        }

        $shared = [];
        $root   = simplexml_load_string($xml);
        if (false === $root) {
            throw new RuntimeException('微信支付账单 XLSX 共享字符串无法解析。');
        }

        foreach ($root->children() as $item) {
            $parts = [];
            $texts = $item->xpath('.//*[local-name()="t"]');
            if (false === $texts) {
                $texts = [];
            }
            foreach ($texts as $text) {
                $parts[] = (string) $text;
            }
            $shared[] = implode('', $parts);
        }

        return $shared;
    }

    /**
     * @param array<int,string> $sharedStrings
     *
     * @return array<int,array<int,string>>
     */
    private function readFirstWorksheetTable(ZipArchive $zip, array $sharedStrings): array
    {
        $xml = $zip->getFromName('xl/worksheets/sheet1.xml');
        if (false === $xml) {
            throw new RuntimeException('微信支付账单 XLSX 缺少工作表。');
        }

        $root = simplexml_load_string($xml);
        if (false === $root) {
            throw new RuntimeException('微信支付账单 XLSX 工作表无法解析。');
        }

        $rowNodes = $root->xpath('//*[local-name()="sheetData"]/*[local-name()="row"]');
        if (false === $rowNodes) {
            $rowNodes = [];
        }

        $rows = [];
        foreach ($rowNodes as $rowNode) {
            $row = [];
            $cellNodes = $rowNode->xpath('./*[local-name()="c"]');
            if (false === $cellNodes) {
                $cellNodes = [];
            }
            foreach ($cellNodes as $cellNode) {
                $reference = (string) ($cellNode['r'] ?? '');
                $column    = $this->columnIndexFromReference($reference);
                if (null === $column) {
                    $column = count($row);
                }
                $row[$column] = $this->cellValue($cellNode, $sharedStrings, $column);
            }
            if ([] !== $row) {
                ksort($row);
                $rows[] = $this->denseRow($row);
            }
        }

        return $rows;
    }

    /**
     * @param array<int,string> $row
     *
     * @return array<int,string>
     */
    private function denseRow(array $row): array
    {
        $max   = max(array_keys($row));
        $dense = [];
        for ($index = 0; $index <= $max; ++$index) {
            $dense[$index] = $row[$index] ?? '';
        }

        return $dense;
    }

    /**
     * @param array<int,string> $sharedStrings
     */
    private function cellValue(\SimpleXMLElement $cell, array $sharedStrings, int $column): string
    {
        $type  = (string) ($cell['t'] ?? '');
        $value = (string) ($cell->xpath('./*[local-name()="v"]')[0] ?? '');
        if ('s' === $type) {
            return $this->clean($sharedStrings[(int) $value] ?? '');
        }
        if ('inlineStr' === $type) {
            $texts = $cell->xpath('.//*[local-name()="t"]');
            if (false === $texts) {
                $texts = [];
            }

            return $this->clean(implode('', array_map(static fn (\SimpleXMLElement $text): string => (string) $text, $texts)));
        }
        if (0 === $column && is_numeric($value)) {
            return $this->excelSerialDate((float) $value)->format('Y-m-d H:i:s');
        }

        return $this->clean($value);
    }

    private function columnIndexFromReference(string $reference): ?int
    {
        if (1 !== preg_match('/^([A-Z]+)/', strtoupper($reference), $matches)) {
            return null;
        }

        $index = 0;
        foreach (str_split($matches[1]) as $letter) {
            $index = $index * 26 + (ord($letter) - 64);
        }

        return $index - 1;
    }

    private function excelSerialDate(float $serial): Carbon
    {
        $days    = (int) floor($serial);
        $seconds = (int) round(($serial - $days) * 86_400);

        return Carbon::create(1899, 12, 30, 0, 0, 0, 'Asia/Shanghai')
            ->addDays($days)
            ->addSeconds($seconds)
        ;
    }

    private function archivedFilename(?Carbon $exportedAt, ?Carbon $start, ?Carbon $end, string $extension): string
    {
        $export = $exportedAt?->format('YmdHi') ?? Carbon::now('Asia/Shanghai')->format('YmdHi');
        $period = sprintf('%s_%s', $start?->format('Ymd') ?? 'unknown', $end?->format('Ymd') ?? 'unknown');

        return sprintf('wechat-pay-%s-%s.%s', $export, $period, $extension);
    }

    private function parseDateTime(string $value): ?Carbon
    {
        if ('' === trim($value)) {
            return null;
        }
        if (is_numeric($value)) {
            return $this->excelSerialDate((float) $value);
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

    private function fireflyAccountName(string $paymentMethod): string
    {
        $primary = trim(explode('&', $paymentMethod)[0] ?? $paymentMethod);
        if (str_contains($primary, '招商银行')) {
            return '招商银行';
        }
        if (str_contains($primary, '中国银行')) {
            return '中国银行';
        }
        if (str_contains($primary, '零钱')) {
            return '微信零钱';
        }
        if ('/' === $primary) {
            return '微信零钱';
        }

        return '' === $primary ? '微信支付' : $primary;
    }

    private function categoryName(string $category): string
    {
        if (str_contains($category, '退款') || str_contains($category, '退回')) {
            return '退款';
        }
        if (str_contains($category, '转账')) {
            return '转账';
        }

        return $category;
    }

    private function fireflyDescription(string $description, string $counterparty, string $direction, string $categoryName): string
    {
        if ('转账' === $categoryName && '' !== $counterparty && '/' !== $counterparty) {
            return '收入' === $direction ? sprintf('收到%s转账', $counterparty) : sprintf('转账给%s', $counterparty);
        }

        return '' === $description ? $counterparty : $description;
    }

    private function clean(string $value): string
    {
        return trim(str_replace("\t", '', $value));
    }

    private function isXlsx(string $content): bool
    {
        return str_starts_with($content, "PK\x03\x04") && str_contains($content, '[Content_Types].xml');
    }
}
