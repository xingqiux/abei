<?php

declare(strict_types=1);

namespace FireflyIII\Http\Controllers\BillInbox;

use Carbon\Carbon;
use FireflyIII\Http\Controllers\Controller;
use FireflyIII\Models\BillArtifact;
use FireflyIII\Models\BillStatementRow;
use FireflyIII\Models\BillTask;
use FireflyIII\Services\BillIngestion\BillInboxSummaryService;
use FireflyIII\Services\BillIngestion\BillStatementRowImportService;
use FireflyIII\Services\BillIngestion\BillStatementRowSplitService;
use FireflyIII\Services\BillIngestion\BillMailboxSyncService;
use FireflyIII\Services\BillIngestion\BillSourceChannelRegistry;
use FireflyIII\Services\BillIngestion\BillTaskActionService;
use FireflyIII\Services\BillIngestion\BillTaskProcessor;
use FireflyIII\Support\Facades\Preferences;
use Illuminate\Contracts\View\Factory;
use Illuminate\Contracts\View\View;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;
use RuntimeException;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use ZipArchive;

final class IndexController extends Controller
{
    public function __construct(
        private readonly BillTaskActionService $actionService,
        private readonly BillMailboxSyncService $mailboxSyncService,
        private readonly BillTaskProcessor $taskProcessor,
        private readonly BillStatementRowImportService $rowImportService,
        private readonly BillStatementRowSplitService $rowSplitService,
        private readonly BillSourceChannelRegistry $channelRegistry,
        private readonly BillInboxSummaryService $summaryService,
    ) {
        parent::__construct();

        $this->middleware(static function ($request, $next) {
            app('view')->share('mainTitleIcon', 'fa-inbox');
            app('view')->share('title', '账单收件箱');

            return $next($request);
        });
    }

    public function index(Request $request): Factory|View
    {
        Log::channel('audit')->info('User visits bill inbox index page.');

        return view('bill-inbox.index', [
            'sourceChannels' => $this->summaryService->channelSummaries(auth()->user()),
            'mailboxStatus'  => $this->mailboxStatus(),
            'builtInChannels'=> $this->channelRegistry->settingsChannels(),
            'statusLabels'   => $this->statusLabels(),
            'statusClasses'  => $this->statusClasses(),
        ]);
    }

    public function channel(Request $request, string $source): Factory|View
    {
        $channel = $this->sourceChannel($source);
        if (null === $channel) {
            throw new NotFoundHttpException();
        }

        $status = (string) $request->query('status', '');
        $query  = BillTask::query()
            ->where('user_id', auth()->id())
            ->where('source', $source)
            ->with([
                'artifacts' => fn ($query) => $query->visibleToUser()->orderBy('id'),
                'mailMessage',
                'currentSecretChallenge',
                'statementRows',
            ])
            ->orderByDesc('received_at')
            ->orderByDesc('id')
        ;

        if ('' !== $status) {
            $query->where('status', $status);
        }
        if ('' === $status) {
            $query->where('status', '!=', 'cleaned');
        }

        $tasks = $query->paginate(25)->withQueryString();
        $stats = BillTask::query()
            ->where('user_id', auth()->id())
            ->where('source', $source)
            ->selectRaw('status, count(*) as total')
            ->groupBy('status')
            ->pluck('total', 'status')
            ->toArray()
        ;

        Log::channel('audit')->info(sprintf('User visits bill inbox channel "%s" page.', $source));

        return view('bill-inbox.channel', [
            'channel'       => $channel,
            'tasks'         => $tasks,
            'stats'         => $stats,
            'currentStatus' => $status,
            'statusLabels'   => $this->statusLabels(),
            'statusClasses'  => $this->statusClasses(),
        ]);
    }

    public function show(Request $request, BillTask $billTask): Factory|View
    {
        $billTask->load([
            'artifacts'        => fn ($query) => $query->visibleToUser()->orderBy('id'),
            'currentSecretChallenge',
            'events'           => fn ($query) => $query->orderByDesc('id'),
            'mailMessage',
            'statementImports' => fn ($query) => $query->orderBy('id'),
        ]);
        $billTask->artifacts->each(function (BillArtifact $artifact) use ($billTask): void {
            $artifact->setAttribute('display_name', $this->artifactDisplayName($billTask, $artifact));
            $artifact->setAttribute('can_preview', $this->canPreviewArtifact($artifact));
        });
        $rowStatus = (string) $request->query('row_status', '');
        $rowTime   = (string) $request->query('row_time', 'all');
        $rowDate   = (string) $request->query('row_date', today(config('app.timezone'))->format('Y-m-d'));
        $rowFrom   = 'day' === $rowTime ? $rowDate : (string) $request->query('row_from', '');
        $rowTo     = 'day' === $rowTime ? $rowDate : (string) $request->query('row_to', '');
        $rows      = $billTask->statementRows()
            ->orderByDesc('occurred_at')
            ->orderBy('row_number')
        ;
        if ('' !== $rowStatus) {
            $rows->where('status', $rowStatus);
        }
        if ('' !== $rowFrom) {
            $rows->where('occurred_at', '>=', $rowFrom.' 00:00:00');
        }
        if ('' !== $rowTo) {
            $rows->where('occurred_at', '<=', $rowTo.' 23:59:59');
        }

        Log::channel('audit')->info(sprintf('User visits bill inbox task #%d page.', $billTask->id));

        return view('bill-inbox.show', [
            'task'         => $billTask,
            'statementRows'=> $rows->get(),
            'rowFilters'   => [
                'status'   => $rowStatus,
                'time'     => $rowTime,
                'date'     => $rowDate,
                'prevDate' => Carbon::parse($rowDate, config('app.timezone'))->subDay()->format('Y-m-d'),
                'nextDate' => Carbon::parse($rowDate, config('app.timezone'))->addDay()->format('Y-m-d'),
                'from'     => $rowFrom,
                'to'       => $rowTo,
            ],
            'subTitle'     => sprintf('任务 #%d', $billTask->id),
            'statusLabels' => $this->statusLabels(),
            'statusClasses'=> $this->statusClasses(),
            'eventLabels'  => $this->eventLabels(),
            'fireflyTypeLabels' => $this->fireflyTypeLabels(),
        ]);
    }

    public function settings(): Factory|View
    {
        Log::channel('audit')->info('User visits bill inbox settings page.');

        return view('bill-inbox.settings', [
            'settings'        => $this->mailboxSettings(),
            'hasPassword'     => '' !== (string) Preferences::getEncrypted('bill_inbox_mailbox_password', '')->data,
            'builtInChannels' => $this->channelRegistry->settingsChannels(),
        ]);
    }

    public function postIgnore(BillTask $billTask): RedirectResponse
    {
        $this->actionService->ignore($billTask);
        session()->flash('success', '账单任务已忽略。');

        return redirect(route('bill-inbox.show', [$billTask->id]));
    }

    public function postRetry(BillTask $billTask): RedirectResponse
    {
        $this->actionService->retry($billTask);
        session()->flash('success', '账单任务已重新排队。');

        return redirect(route('bill-inbox.show', [$billTask->id]));
    }

    public function postSecret(Request $request, BillTask $billTask): RedirectResponse
    {
        $request->validate([
            'value' => ['required', 'string', 'min:1'],
        ]);

        try {
            $processedTask = $this->actionService->submitSecret($billTask, (string) $request->string('value'));
            session()->flash('success', $this->secretSubmittedMessage($processedTask));
        } catch (RuntimeException $e) {
            session()->flash('error', $e->getMessage());
        }

        if ('channel' === (string) $request->input('redirect_to', '')) {
            $source = (string) $request->input('source', $billTask->source);

            return redirect(route('bill-inbox.channel', ['source' => $source]));
        }

        if ('index' === (string) $request->input('redirect_to', '')) {
            $status = (string) $request->input('status', '');

            return redirect(route('bill-inbox.index', '' === $status ? [] : ['status' => $status]));
        }

        return redirect(route('bill-inbox.show', [$billTask->id]));
    }

    public function postSync(): RedirectResponse
    {
        $result    = $this->mailboxSyncService->syncForUser(auth()->user(), 25);
        $processed = $this->taskProcessor->processBatch(25, auth()->user());

        if ([] !== $result->errors) {
            session()->flash('error', implode(' ', $result->errors));
        }

        session()->flash('success', sprintf(
            '邮箱同步完成：扫描 %d 封，新增 %d 个任务，忽略 %d 封，重复 %d 封，失败 %d 封；已推进 %d 个任务。',
            $result->scanned,
            $result->created,
            $result->ignored,
            $result->duplicates,
            $result->failed,
            $processed->processed
        ));

        return redirect(route('bill-inbox.index'));
    }

    public function postCleanupStale(): RedirectResponse
    {
        $archived = $this->actionService->cleanupStale(auth()->user());
        session()->flash('success', sprintf('已归档 %d 个过时账单任务。', $archived));

        return redirect(route('bill-inbox.index'));
    }

    public function postArchive(BillTask $billTask): RedirectResponse
    {
        $this->actionService->archive($billTask);
        session()->flash('success', '账单任务已归档。');

        if ('channel' === (string) request()->input('redirect_to', '')) {
            $source = (string) request()->input('source', $billTask->source);

            return redirect(route('bill-inbox.channel', ['source' => $source]));
        }

        return redirect(route('bill-inbox.index'));
    }

    public function postArchiveMany(Request $request): RedirectResponse
    {
        $ids      = array_map('intval', $request->input('task_ids', []));
        $archived = [] === $ids ? 0 : $this->actionService->archiveMany(auth()->user(), $ids);
        session()->flash('success', sprintf('已归档 %d 个账单任务。', $archived));

        if ('channel' === (string) $request->input('redirect_to', '')) {
            $source = (string) $request->input('source', '');
            if (null !== $this->sourceChannel($source)) {
                return redirect(route('bill-inbox.channel', ['source' => $source]));
            }
        }

        return redirect(route('bill-inbox.index'));
    }

    public function postUpdateRow(Request $request, BillStatementRow $billStatementRow): RedirectResponse
    {
        $validated = $request->validate([
            'occurred_at'          => ['nullable', 'date'],
            'platform_category'    => ['nullable', 'string', 'max:255'],
            'counterparty'         => ['nullable', 'string', 'max:255'],
            'description'          => ['nullable', 'string', 'max:4096'],
            'direction'            => ['nullable', 'string', 'max:255'],
            'amount'               => ['nullable', 'numeric'],
            'payment_method'       => ['nullable', 'string', 'max:255'],
            'transaction_status'   => ['nullable', 'string', 'max:255'],
            'firefly_type'         => ['nullable', 'string', 'in:withdrawal,deposit,transfer'],
            'firefly_date'         => ['nullable', 'date'],
            'firefly_amount'       => ['nullable', 'numeric'],
            'firefly_description'  => ['nullable', 'string', 'max:1000'],
            'source_name'          => ['nullable', 'string', 'max:255'],
            'destination_name'     => ['nullable', 'string', 'max:255'],
            'category_name'        => ['nullable', 'string', 'max:255'],
            'notes'                => ['nullable', 'string', 'max:32768'],
        ]);

        $editableMap = [
            'occurred_at'        => '交易时间',
            'platform_category'  => '交易分类',
            'counterparty'       => '交易对方',
            'description'        => '商品说明',
            'direction'          => '收/支',
            'amount'             => '金额',
            'payment_method'     => '收/付款方式',
            'transaction_status' => '交易状态',
        ];
        $editable    = is_array($billStatementRow->editable_data) ? $billStatementRow->editable_data : [];
        foreach ($validated as $key => $value) {
            $billStatementRow->{$key} = $value;
            if (array_key_exists($key, $editableMap)) {
                $editable[$editableMap[$key]] = null === $value ? '' : (string) $value;
            }
        }
        $billStatementRow->editable_data = $editable;
        $billStatementRow->save();

        session()->flash('success', '流水已保存。');

        return redirect(route('bill-inbox.show', $this->showRedirectParams($request, (int) $billStatementRow->bill_task_id)));
    }

    public function postSplitRow(Request $request, BillStatementRow $billStatementRow): RedirectResponse
    {
        $validated = $request->validate([
            'splits'                    => ['required', 'array', 'min:2'],
            'splits.*.payment_method'   => ['nullable', 'string', 'max:255'],
            'splits.*.source_name'      => ['nullable', 'string', 'max:255'],
            'splits.*.amount'           => ['required', 'numeric'],
        ]);

        try {
            $children = $this->rowSplitService->split($billStatementRow, $validated['splits']);
            session()->flash('success', sprintf('已拆分出 %d 条流水。', count($children)));
        } catch (RuntimeException $e) {
            session()->flash('error', $e->getMessage());
        }

        return redirect(route('bill-inbox.show', $this->showRedirectParams($request, (int) $billStatementRow->bill_task_id)));
    }

    public function postImportRows(Request $request, BillTask $billTask): RedirectResponse
    {
        $ids    = array_map('intval', $request->input('row_ids', []));
        $result = $this->rowImportService->importTaskRows(auth()->user(), $billTask->id, $ids, true);

        session()->flash('success', sprintf('已存入 %d 条流水，跳过 %d 条，失败 %d 条。', $result['summary']['imported'], $result['summary']['skipped'], $result['summary']['failed']));

        return redirect(route('bill-inbox.show', $this->showRedirectParams($request, $billTask->id)));
    }

    /**
     * Build the query parameters for a redirect back to the show page, preserving the
     * caller-supplied row filters (status/time/date/from/to) so that a form submission
     * from a filtered view does not bounce the user back to the unfiltered "all" view.
     *
     * @return array<string, int|string>
     */
    private function showRedirectParams(Request $request, int $taskId): array
    {
        $params = ['billTask' => $taskId];

        foreach (['row_status', 'row_time', 'row_date', 'row_from', 'row_to'] as $key) {
            $value = (string) $request->input($key, '');
            if ('' !== $value) {
                $params[$key] = $value;
            }
        }

        return $params;
    }

    public function download(BillArtifact $billArtifact): StreamedResponse
    {
        if ($billArtifact->isInternalProcessingArtifact()) {
            throw new NotFoundHttpException();
        }

        if (null === $billArtifact->path || '' === $billArtifact->path || !Storage::disk('local')->exists($billArtifact->path)) {
            throw new NotFoundHttpException();
        }

        return response()->streamDownload(
            static function () use ($billArtifact): void {
                echo Storage::disk('local')->get((string) $billArtifact->path);
            },
            $billArtifact->filename ?? basename((string) $billArtifact->path)
        );
    }

    public function preview(BillArtifact $billArtifact): Factory|View
    {
        if (!$this->canPreviewArtifact($billArtifact)) {
            throw new NotFoundHttpException();
        }

        $previewArtifact = $this->previewArtifact($billArtifact);
        $content         = null;
        $tableRows       = [];
        if (in_array($previewArtifact->kind, ['csv', 'txt', 'text'], true)) {
            $content = $this->readTextPreview($previewArtifact);
        }
        if ('xlsx' === $previewArtifact->kind) {
            $tableRows = $this->readXlsxPreviewRows($previewArtifact);
        }

        return view('bill-inbox.preview', [
            'artifact'        => $billArtifact,
            'previewArtifact' => $previewArtifact,
            'content'         => $content,
            'tableRows'       => $tableRows,
            'task'            => $billArtifact->billTask,
        ]);
    }

    public function postSettings(Request $request): RedirectResponse
    {
        $validated = $request->validate([
            'enabled'           => ['nullable', 'boolean'],
            'provider'          => ['nullable', 'string', 'in:gmail,imap'],
            'email'             => ['nullable', 'string', 'max:255'],
            'host'              => ['nullable', 'string', 'max:255'],
            'port'              => ['nullable', 'integer', 'min:1', 'max:65535'],
            'encryption'        => ['nullable', 'string', 'in:none,ssl,tls,starttls'],
            'username'          => ['nullable', 'string', 'max:255'],
            'password'          => ['nullable', 'string', 'max:1024'],
            'folder'            => ['nullable', 'string', 'max:255'],
        ]);

        $provider   = (string) ($validated['provider'] ?? 'gmail');
        $email      = (string) ($validated['email'] ?? '');
        $host       = trim((string) ($validated['host'] ?? ''));
        $port       = (int) ($validated['port'] ?? 993);
        $encryption = (string) ($validated['encryption'] ?? 'ssl');
        $folder     = trim((string) ($validated['folder'] ?? ''));
        $username   = trim((string) ($validated['username'] ?? ''));

        if ('gmail' === $provider) {
            $host       = 'imap.gmail.com';
            $port       = 993;
            $encryption = 'ssl';
            $folder     = '' === $folder ? 'INBOX' : $folder;
            $username   = '' === $username ? $email : $username;
        }

        $folder     = '' === $folder ? 'INBOX' : $folder;

        Preferences::set('bill_inbox_mailbox_enabled', $request->boolean('enabled'));
        Preferences::set('bill_inbox_mailbox_provider', $provider);
        Preferences::set('bill_inbox_mailbox_email', $email);
        Preferences::set('bill_inbox_mailbox_host', $host);
        Preferences::set('bill_inbox_mailbox_port', $port);
        Preferences::set('bill_inbox_mailbox_encryption', $encryption);
        Preferences::set('bill_inbox_mailbox_username', $username);
        Preferences::set('bill_inbox_mailbox_folder', $folder);
        Preferences::set('bill_inbox_processing_rules', $this->channelRegistry->processingRules());
        Preferences::set('bill_inbox_quick_gmail_label', '');
        Preferences::set('bill_inbox_quick_keywords', '');

        if (array_key_exists('password', $validated) && '' !== (string) $validated['password']) {
            Preferences::setEncrypted('bill_inbox_mailbox_password', (string) $validated['password']);
        }

        Preferences::mark();
        session()->flash('success', '账单收件箱邮箱配置已保存。');

        return redirect(route('bill-inbox.settings'));
    }

    private function mailboxSettings(): array
    {
        return [
            'enabled'    => true === Preferences::get('bill_inbox_mailbox_enabled', false)->data,
            'provider'   => (string) Preferences::get('bill_inbox_mailbox_provider', 'gmail')->data,
            'email'      => (string) Preferences::get('bill_inbox_mailbox_email', '')->data,
            'host'       => (string) Preferences::get('bill_inbox_mailbox_host', 'imap.gmail.com')->data,
            'port'       => (int) Preferences::get('bill_inbox_mailbox_port', 993)->data,
            'encryption' => (string) Preferences::get('bill_inbox_mailbox_encryption', 'ssl')->data,
            'username'   => (string) Preferences::get('bill_inbox_mailbox_username', '')->data,
            'folder'     => (string) Preferences::get('bill_inbox_mailbox_folder', 'INBOX')->data,
        ];
    }

    private function mailboxStatus(): array
    {
        $settings = $this->mailboxSettings();

        return [
            'enabled'     => $settings['enabled'],
            'provider'    => $settings['provider'],
            'email'       => $settings['email'],
            'folder'      => $settings['folder'],
            'hasPassword' => '' !== (string) Preferences::getEncrypted('bill_inbox_mailbox_password', '')->data,
        ];
    }

    /**
     * @return null|array<string, string>
     */
    private function sourceChannel(string $source): ?array
    {
        foreach ($this->channelRegistry->settingsChannels() as $channel) {
            if ($source === (string) $channel['source']) {
                return $channel;
            }
        }

        return null;
    }

    private function artifactDisplayName(BillTask $billTask, BillArtifact $artifact): string
    {
        if ('wechat' !== $billTask->source) {
            return (string) ($artifact->filename ?? $artifact->path ?? '-');
        }

        $metadata = is_array($artifact->metadata) ? $artifact->metadata : [];
        if ('zip' === $artifact->kind || 'remote_download' === ($metadata['source'] ?? null)) {
            return '原始压缩包';
        }
        if (in_array($artifact->kind, ['csv', 'xlsx'], true) || 'wechat_zip_extract' === ($metadata['source'] ?? null)) {
            return '账单明细';
        }

        return (string) ($artifact->filename ?? $artifact->path ?? '-');
    }

    private function canPreviewArtifact(BillArtifact $artifact): bool
    {
        return $this->isDirectPreviewArtifact($artifact)
            || $this->extractedTextPreviewArtifact($artifact) instanceof BillArtifact
        ;
    }

    private function isDirectPreviewArtifact(BillArtifact $artifact): bool
    {
        return !$artifact->isInternalProcessingArtifact()
            && false === $artifact->encrypted
            && in_array($artifact->kind, ['csv', 'xlsx', 'txt', 'text', 'pdf'], true)
            && null !== $artifact->path
            && '' !== $artifact->path
            && Storage::disk('local')->exists($artifact->path)
        ;
    }

    private function previewArtifact(BillArtifact $artifact): BillArtifact
    {
        if ($this->isDirectPreviewArtifact($artifact)) {
            return $artifact;
        }

        $previewArtifact = $this->extractedTextPreviewArtifact($artifact);
        if ($previewArtifact instanceof BillArtifact) {
            return $previewArtifact;
        }

        throw new NotFoundHttpException();
    }

    private function extractedTextPreviewArtifact(BillArtifact $artifact): ?BillArtifact
    {
        if ('pdf' !== $artifact->kind) {
            return null;
        }

        $previewArtifact = $artifact->children()
            ->whereIn('kind', ['txt', 'text'])
            ->where('encrypted', false)
            ->whereMetadataSource('boc_pdf_text_extract')
            ->orderByDesc('id')
            ->first()
        ;
        if (!$previewArtifact instanceof BillArtifact) {
            return null;
        }
        if (null === $previewArtifact->path || '' === $previewArtifact->path || !Storage::disk('local')->exists($previewArtifact->path)) {
            return null;
        }

        return $previewArtifact;
    }

    private function readTextPreview(BillArtifact $artifact): string
    {
        return mb_convert_encoding(substr(Storage::disk('local')->get((string) $artifact->path), 0, 200_000), 'UTF-8', 'UTF-8,GB18030,GBK,BIG5');
    }

    /**
     * @return array<int,array<int,string>>
     */
    private function readXlsxPreviewRows(BillArtifact $artifact): array
    {
        $zip = new ZipArchive();
        if (true !== $zip->open(Storage::disk('local')->path((string) $artifact->path))) {
            return [];
        }

        try {
            $sharedStrings = $this->readXlsxSharedStrings($zip);
            $worksheetXml  = $this->readFirstXlsxWorksheet($zip);
            if (null === $worksheetXml) {
                return [];
            }

            $worksheet = simplexml_load_string($worksheetXml);
            if (false === $worksheet || null === ($worksheet->sheetData ?? null)) {
                return [];
            }

            $rows = [];
            foreach ($worksheet->sheetData->row as $row) {
                $cells = [];
                foreach ($row->c as $cell) {
                    $cells[$this->xlsxColumnIndex((string) $cell['r'])] = $this->xlsxCellValue($cell, $sharedStrings);
                }
                ksort($cells);
                if ([] !== array_filter($cells, static fn (string $value): bool => '' !== trim($value))) {
                    $rows[] = array_values($cells);
                }
                if (count($rows) >= 300) {
                    break;
                }
            }

            return $rows;
        } finally {
            $zip->close();
        }
    }

    /**
     * @return array<int,string>
     */
    private function readXlsxSharedStrings(ZipArchive $zip): array
    {
        $xml = $zip->getFromName('xl/sharedStrings.xml');
        if (false === $xml) {
            return [];
        }

        $strings = simplexml_load_string($xml);
        if (false === $strings) {
            return [];
        }

        $result = [];
        foreach ($strings->si as $item) {
            $result[] = $this->xlsxTextNodeValue($item);
        }

        return $result;
    }

    private function readFirstXlsxWorksheet(ZipArchive $zip): ?string
    {
        $sheet = $zip->getFromName('xl/worksheets/sheet1.xml');
        if (false !== $sheet) {
            return $sheet;
        }

        for ($index = 0; $index < $zip->numFiles; ++$index) {
            $stat = $zip->statIndex($index);
            $name = false === $stat ? '' : (string) ($stat['name'] ?? '');
            if (str_starts_with($name, 'xl/worksheets/sheet') && str_ends_with($name, '.xml')) {
                $sheet = $zip->getFromIndex($index);

                return false === $sheet ? null : $sheet;
            }
        }

        return null;
    }

    /**
     * @param array<int,string> $sharedStrings
     */
    private function xlsxCellValue(\SimpleXMLElement $cell, array $sharedStrings): string
    {
        $type  = (string) $cell['t'];
        $value = (string) ($cell->v ?? '');
        if ('s' === $type) {
            return $sharedStrings[(int) $value] ?? $value;
        }
        if ('inlineStr' === $type && null !== ($cell->is ?? null)) {
            return $this->xlsxTextNodeValue($cell->is);
        }

        return $value;
    }

    private function xlsxTextNodeValue(\SimpleXMLElement $node): string
    {
        $text = null === ($node->t ?? null) ? '' : (string) $node->t;
        foreach ($node->r as $run) {
            $text .= (string) ($run->t ?? '');
        }

        return $text;
    }

    private function xlsxColumnIndex(string $reference): int
    {
        if (1 !== preg_match('/^([A-Z]+)/i', $reference, $matches)) {
            return 0;
        }

        $index = 0;
        foreach (str_split(strtoupper($matches[1])) as $letter) {
            $index = $index * 26 + ord($letter) - 64;
        }

        return max(0, $index - 1);
    }

    private function secretSubmittedMessage(BillTask $billTask): string
    {
        return match ($billTask->status) {
            'parsed'  => $billTask->statementRows()->exists() ? '账单已解析，已生成流水明细。' : '账单已解压，可下载附件查看。',
            'ready'   => '验证码/密码已提交，等待处理。',
            default   => '验证码/密码已提交。',
        };
    }

    private function statusLabels(): array
    {
        return [
            'received'     => '已接收',
            'ready'        => '待处理',
            'needs_secret' => '需要验证码',
            'parsed'       => '已解析',
            'imported'     => '已存入',
            'failed'       => '处理失败',
            'unknown'      => '未识别',
            'ignored'      => '已忽略',
            'cleaned'      => '已归档',
            'pending'      => '待存入',
            'needs_split'  => '待拆分',
            'split'        => '已拆分',
        ];
    }

    private function fireflyTypeLabels(): array
    {
        return [
            'withdrawal' => '支出',
            'deposit'    => '收入',
            'transfer'   => '转账',
        ];
    }

    private function statusClasses(): array
    {
        return [
            'received'     => 'gc-status-received',
            'ready'        => 'gc-status-ready',
            'needs_secret' => 'gc-status-attention',
            'parsed'       => 'gc-status-parsed',
            'imported'     => 'gc-status-imported',
            'failed'       => 'gc-status-failed',
            'unknown'      => 'gc-status-failed',
            'ignored'      => 'gc-status-archived',
            'cleaned'      => 'gc-status-archived',
            'pending'      => 'gc-status-pending',
            'needs_split'  => 'gc-status-attention',
            'split'        => 'gc-status-parsed',
        ];
    }

    private function eventLabels(): array
    {
        return [
            'task.created'          => '创建任务',
            'challenge.created'     => '需要验证码',
            'task.ready'            => '准备处理',
            'challenge.consumed'    => '已提交验证码',
            'task.parsed'           => '已解析账单',
            'task.archived'         => '已归档',
            'task.cleaned'          => '已归档',
            'task.failed'           => '处理失败',
            'task.unknown'          => '未识别',
            'task.retry_requested'  => '重新处理',
            'task.ignored'          => '已忽略',
            'remote_file.downloaded'=> '已下载账单文件',
            'remote_file.failed'    => '下载账单文件失败',
        ];
    }
}
