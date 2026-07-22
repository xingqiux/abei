<?php

declare(strict_types=1);

namespace FireflyIII\Api\V1\Controllers\Models\BillTask;

use FireflyIII\Api\V1\Controllers\Controller;
use FireflyIII\Models\BillStatementRow;
use FireflyIII\Models\BillTask;
use FireflyIII\Rules\IsValidPositiveAmount;
use FireflyIII\Services\BillIngestion\BillStatementRowImportService;
use FireflyIII\Services\BillIngestion\BillStatementCurrencyResolver;
use FireflyIII\Services\BillIngestion\BillStatementRowSplitService;
use FireflyIII\Services\BillIngestion\BillTaskActionService;
use FireflyIII\Services\BillIngestion\BillTaskProcessor;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use RuntimeException;

final class ActionController extends Controller
{
    use BillTaskResponse;

    public function __construct(
        private readonly BillTaskActionService $actionService,
        private readonly BillTaskProcessor $taskProcessor,
        private readonly BillStatementRowImportService $rowImportService,
        private readonly BillStatementRowSplitService $rowSplitService,
        private readonly BillStatementCurrencyResolver $currencyResolver,
    ) {}

    public function ignore(BillTask $billTask): JsonResponse
    {
        return response()->json($this->itemResponse($this->actionService->ignore($billTask)));
    }

    public function retry(BillTask $billTask): JsonResponse
    {
        $retried = $this->actionService->retry($billTask);
        $this->taskProcessor->process($retried);

        return response()->json($this->itemResponse($retried->refresh()));
    }

    public function archive(BillTask $billTask): JsonResponse
    {
        return response()->json($this->itemResponse($this->actionService->archive($billTask)));
    }

    public function archiveMany(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'ids'   => ['required', 'array'],
            'ids.*' => ['integer'],
        ]);

        $archived = $this->actionService->archiveMany(auth()->user(), array_map('intval', $validated['ids']));

        return response()->json([
            'data' => [
                'type'       => 'bill-task-archive-result',
                'attributes' => [
                    'archived' => $archived,
                ],
                'archived'   => $archived,
            ],
        ]);
    }

    public function import(Request $request, BillTask $billTask): JsonResponse
    {
        $validated = $request->validate([
            'row_ids'   => ['nullable', 'array'],
            'row_ids.*' => ['integer'],
            'all'             => ['nullable', 'boolean'],
            'confirm'         => ['nullable', 'boolean'],
            'include_payload' => ['nullable', 'boolean'],
        ]);

        $rowIds = $request->boolean('all') ? [] : array_map('intval', $validated['row_ids'] ?? []);
        $result = $this->rowImportService->importTaskRows(auth()->user(), $billTask->id, $rowIds, $request->boolean('confirm'), [
            'include_payload' => $request->boolean('include_payload'),
        ]);

        return response()->json($result);
    }

    public function updateRow(Request $request, BillStatementRow $billStatementRow): JsonResponse
    {
        $validated = $request->validate([
            'occurred_at'           => ['nullable', 'date'],
            'platform_category'     => ['nullable', 'string', 'max:255'],
            'counterparty'          => ['nullable', 'string', 'max:255'],
            'counterparty_account'  => ['nullable', 'string', 'max:255'],
            'description'           => ['nullable', 'string', 'max:4096'],
            'direction'             => ['nullable', 'string', 'max:255'],
            'amount'                => ['nullable', new IsValidPositiveAmount()],
            'payment_method'        => ['nullable', 'string', 'max:255'],
            'transaction_status'    => ['nullable', 'string', 'max:255'],
            'platform_order_no'     => ['nullable', 'string', 'max:255'],
            'merchant_order_no'     => ['nullable', 'string', 'max:255'],
            'remark'                => ['nullable', 'string', 'max:4096'],
            'firefly_type'          => ['nullable', 'string', 'in:withdrawal,deposit,transfer'],
            'firefly_date'          => ['nullable', 'date'],
            'firefly_amount'        => ['nullable', new IsValidPositiveAmount()],
            'firefly_description'   => ['nullable', 'string', 'max:1000'],
            'source_name'           => ['nullable', 'string', 'max:255'],
            'destination_name'      => ['nullable', 'string', 'max:255'],
            'category_name'         => ['nullable', 'string', 'max:255'],
            'notes'                 => ['nullable', 'string', 'max:32768'],
            'tags'                  => ['nullable', 'array'],
            'tags.*'                => ['string', 'max:255'],
        ]);

        $editableMap = [
            'occurred_at'          => '交易时间',
            'platform_category'    => '交易分类',
            'counterparty'         => '交易对方',
            'counterparty_account' => '对方账号',
            'description'          => '商品说明',
            'direction'            => '收/支',
            'amount'               => '金额',
            'payment_method'       => '收/付款方式',
            'transaction_status'   => '交易状态',
            'platform_order_no'    => '交易订单号',
            'merchant_order_no'    => '商家订单号',
            'remark'               => '备注',
        ];
        $editable    = is_array($billStatementRow->editable_data) ? $billStatementRow->editable_data : [];

        foreach ($validated as $key => $value) {
            $billStatementRow->{$key} = $value;
            if (array_key_exists($key, $editableMap)) {
                $editable[$editableMap[$key]] = null === $value ? '' : (string) $value;
            }
        }

        $billStatementRow->editable_data = $editable;
        if ([] !== $validated) {
            $billStatementRow->user_modified_at = now('Asia/Shanghai');
        }
        $billStatementRow->save();

        return response()->json(['data' => $this->statementRowResource($billStatementRow->refresh())]);
    }

    public function showRow(BillStatementRow $billStatementRow): JsonResponse
    {
        return response()->json(['data' => $this->statementRowResource($billStatementRow)]);
    }

    public function splitRow(Request $request, BillStatementRow $billStatementRow): JsonResponse
    {
        $validated = $request->validate([
            'splits'                    => ['required', 'array', 'min:2'],
            'splits.*.payment_method'   => ['nullable', 'string', 'max:255'],
            'splits.*.source_name'      => ['nullable', 'string', 'max:255'],
            'splits.*.amount'           => ['required', 'numeric', 'gt:0'],
            'splits.*.description'      => ['required', 'string', 'min:1', 'max:1000'],
            'splits.*.category_name'    => ['nullable', 'string', 'max:255'],
        ]);

        try {
            $children = $this->rowSplitService->split($billStatementRow, $validated['splits']);
        } catch (RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }

        return response()->json([
            'parent' => $this->statementRowResource($billStatementRow->refresh()),
            'data'   => array_map(fn (BillStatementRow $row): array => $this->statementRowResource($row->refresh()), $children),
        ]);
    }

    public function secret(Request $request, BillTask $billTask): JsonResponse
    {
        $request->validate([
            'value' => ['required', 'string', 'min:1'],
        ]);

        try {
            return response()->json($this->itemResponse($this->actionService->submitSecret($billTask, (string) $request->string('value'))));
        } catch (RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }
    }
}
