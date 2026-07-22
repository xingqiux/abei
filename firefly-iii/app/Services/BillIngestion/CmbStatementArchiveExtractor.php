<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion;

use FireflyIII\Models\BillArtifact;
use Illuminate\Support\Facades\Storage;
use RuntimeException;
use ZipArchive;

class CmbStatementArchiveExtractor
{
    public function __construct(private readonly CmbStatementImportService $importService) {}

    /**
     * @return array<int, BillArtifact>
     */
    public function extract(BillArtifact $archive, #[\SensitiveParameter] string $password): array
    {
        if ('' === trim($password)) {
            throw new RuntimeException('招商银行账单解压码不能为空。');
        }
        if (null === $archive->path || '' === $archive->path) {
            throw new RuntimeException('招商银行账单附件缺少存储路径。');
        }
        if (!Storage::disk('local')->exists($archive->path)) {
            throw new RuntimeException('招商银行账单附件文件不存在。');
        }

        $zip = new ZipArchive();
        if (true !== $zip->open(Storage::disk('local')->path($archive->path))) {
            throw new RuntimeException('无法打开招商银行账单压缩包。');
        }

        try {
            $zip->setPassword($password);
            $artifacts = [];
            for ($index = 0; $index < $zip->numFiles; ++$index) {
                $stat = $zip->statIndex($index);
                if (false === $stat) {
                    continue;
                }

                $name = (string) ($stat['name'] ?? '');
                if ('' === $name || str_ends_with($name, '/')) {
                    continue;
                }

                $content = $zip->getFromIndex($index);
                if (false === $content) {
                    throw new RuntimeException('招商银行账单解压失败，请检查解压码是否正确。');
                }

                $artifacts[] = $this->storeExtractedFile($archive, $name, $content);
            }

            if ([] === $artifacts) {
                throw new RuntimeException('招商银行账单压缩包中没有可处理的文件。');
            }

            return $artifacts;
        } finally {
            $zip->close();
        }
    }

    private function storeExtractedFile(BillArtifact $archive, string $filename, string $content): BillArtifact
    {
        $safeName = preg_replace('/[\/\\\\]+/', '_', basename($filename));
        if (null === $safeName || '' === $safeName || '0' === $safeName) {
            $safeName = 'cmb-statement.dat';
        }
        $kind     = $this->kindForFilename($safeName);
        $path     = sprintf(
            'bill-inbox/%d/derived/%s-%s',
            $archive->bill_task_id,
            str_pad((string) $archive->id, 6, '0', STR_PAD_LEFT),
            $safeName
        );

        Storage::disk('local')->put($path, $content);

        $artifact = BillArtifact::query()->create([
            'bill_task_id'             => $archive->bill_task_id,
            'derived_from_artifact_id' => $archive->id,
            'kind'                     => $kind,
            'filename'                 => $safeName,
            'path'                     => $path,
            'checksum'                 => hash('sha256', $content),
            'encrypted'                => false,
            'metadata'                 => [
                'source'        => 'cmb_zip_extract',
                'original_name' => $filename,
                'size'          => strlen($content),
                'parser_status' => 'waiting_for_sample_structure',
            ],
        ]);

        if ('pdf' === $kind) {
            $this->importService->importArtifact($artifact);
            $artifact->refresh();
        }

        return $artifact;
    }

    private function kindForFilename(string $filename): string
    {
        $extension = strtolower(pathinfo($filename, PATHINFO_EXTENSION));

        return match ($extension) {
            'csv' => 'csv',
            'xls', 'xlsx' => 'xlsx',
            'pdf' => 'pdf',
            'json' => 'json',
            'txt' => 'text',
            default => 'other',
        };
    }
}
