<?php

declare(strict_types=1);

namespace FireflyIII\Services\BillIngestion\Channels;

use Carbon\Carbon;
use FireflyIII\Models\BillArtifact;
use FireflyIII\Models\BillTask;
use FireflyIII\Services\BillIngestion\BillSourceChannel;
use FireflyIII\Services\BillIngestion\BocStatementImportService;
use Illuminate\Support\Facades\Storage;
use RuntimeException;
use Symfony\Component\Process\Process;

class BocTransactionBillSourceChannel implements BillSourceChannel
{
    public function __construct(private readonly BocStatementImportService $importService) {}

    public function source(): string
    {
        return 'boc';
    }

    public function displayName(): string
    {
        return '中国银行交易流水';
    }

    /**
     * @return array<int, string>
     */
    public function profileIds(): array
    {
        return ['boc-transaction-statement'];
    }

    public function prepare(BillTask $task): bool
    {
        return true;
    }

    public function needsSecret(BillTask $task): bool
    {
        return $task->artifacts()
            ->where('kind', 'pdf')
            ->where('encrypted', true)
            ->exists()
        ;
    }

    public function secretPrompt(BillTask $task): string
    {
        return '请输入中国银行APP“交易流水打印”申请记录中的打开密码';
    }

    public function process(BillTask $task, #[\SensitiveParameter] ?string $secret = null): bool
    {
        if ($this->needsSecret($task) && (null === $secret || '' === trim($secret))) {
            $this->openSecretChallenge($task);

            return true;
        }

        $created                          = $this->extractPdfTextArtifacts($task, (string) $secret);
        $rowCount                         = $task->statementRows()->count();
        $metadata                         = is_array($task->metadata) ? $task->metadata : [];
        $metadata['parser_status']        = $rowCount > 0 ? 'parsed' : 'waiting_for_pdf_mapping';
        $metadata['extracted_text_artifact_count'] = $created;
        $metadata['parsed_row_count']      = $rowCount;
        $metadata['password_submitted_at'] = Carbon::now('Asia/Shanghai')->toAtomString();
        $task->metadata                   = $metadata;
        $task->status                     = 'parsed';
        $task->error_code                 = null;
        $task->error_message              = null;
        $task->save();
        $message = $rowCount > 0
            ? sprintf('中国银行账单已解析，生成 %d 条流水明细', $rowCount)
            : '中国银行账单密码已提交，等待 PDF 字段映射确认';
        $this->appendEvent($task, 'task.parsed', $message);

        return true;
    }

    public function shouldProcessAfterSecret(BillTask $task): bool
    {
        return true;
    }

    private function extractPdfTextArtifacts(BillTask $task, #[\SensitiveParameter] string $secret): int
    {
        $created = 0;
        $pdfs    = $task->artifacts()
            ->where('kind', 'pdf')
            ->where('encrypted', true)
            ->orderBy('id')
            ->get()
        ;

        foreach ($pdfs as $pdf) {
            $existingTextArtifact = $pdf->children()
                ->where('kind', 'txt')
                ->whereMetadataSource('boc_pdf_text_extract')
                ->orderBy('id')
                ->first()
            ;
            if ($existingTextArtifact instanceof BillArtifact) {
                if (!$existingTextArtifact->statementImport && null !== $existingTextArtifact->path && Storage::disk('local')->exists($existingTextArtifact->path)) {
                    $this->importService->importExtractedText($existingTextArtifact, Storage::disk('local')->get($existingTextArtifact->path));
                }

                continue;
            }
            if (null === $pdf->path || '' === $pdf->path || !Storage::disk('local')->exists($pdf->path)) {
                throw new RuntimeException('中国银行账单 PDF 文件不存在。');
            }

            $text     = $this->extractPdfText(Storage::disk('local')->path($pdf->path), $secret);
            $filename = $this->textFilename((string) $pdf->filename);
            $path     = sprintf('bill-inbox/%d/derived/%s', $task->id, $filename);
            Storage::disk('local')->put($path, $text);

            $textArtifact = $pdf->children()->create([
                'bill_task_id'              => $task->id,
                'kind'                      => 'txt',
                'filename'                  => $filename,
                'path'                      => $path,
                'checksum'                  => hash('sha256', $text),
                'encrypted'                 => false,
                'metadata'                  => [
                    'source'          => 'boc_pdf_text_extract',
                    'internal'        => true,
                    'parser_status'   => 'waiting_for_pdf_mapping',
                    'text_extractor'  => 'pdftotext-layout',
                    'original_name'   => $pdf->filename,
                ],
            ]);
            $this->importService->importExtractedText($textArtifact, $text);
            ++$created;
        }

        return $created;
    }

    private function extractPdfText(string $path, #[\SensitiveParameter] string $secret): string
    {
        $process = new Process(['pdftotext', '-layout', '-upw', $secret, $path, '-']);
        $process->run();
        if (!$process->isSuccessful()) {
            throw new RuntimeException('中国银行账单 PDF 文本提取失败，请确认打开密码是否正确。');
        }

        return $process->getOutput();
    }

    private function openSecretChallenge(BillTask $task): void
    {
        $challenge = $task->secretChallenges()->create([
            'kind'     => 'password',
            'prompt'   => $this->secretPrompt($task),
            'status'   => 'open',
            'attempts' => 0,
        ]);

        $task->status                      = 'needs_secret';
        $task->current_secret_challenge_id = $challenge->id;
        $task->save();
        $this->appendEvent($task, 'challenge.created', '任务需要密码或验证码');
    }

    private function textFilename(string $filename): string
    {
        $base = pathinfo($filename, PATHINFO_FILENAME);
        $base = preg_replace('/[\/\\\\]+/', '_', '' === $base ? 'boc-transaction-statement' : $base);
        if (null === $base || '' === $base || '0' === $base) {
            $base = 'boc-transaction-statement';
        }

        return $base.'.txt';
    }

    private function appendEvent(BillTask $task, string $eventType, string $message): void
    {
        $task->events()->create([
            'event_type' => $eventType,
            'message'    => $message,
        ]);
    }
}
