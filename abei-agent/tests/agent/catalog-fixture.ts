/**
 * 能力目录的快照，取自 abei-api 的 `GET /v1/catalog`（版本 0.1.0）。
 *
 * 只留测试用得着的几条能力，字段一字未改。目录形状变了就把这份重新导出来——
 * 它存在的意义正是让 agent 这边对目录的假设在编译期和测试里暴露出来。
 */

import type { AbeiCapability } from '../../src/agent/abei-api.js';

const CATALOG = {
  version: '0.1.0',
  resources: [
    {
      aliases: ['tx', 'txn', 'transaction'],
      description: '账本里的收入、支出和转账。',
      label: '交易',
      name: 'transactions',
    },
    {
      aliases: ['bill', 'task', 'tasks', 'inbox'],
      description: '收件箱里的一份份账单：一封邮件、一个附件，解析后等着入账。',
      label: '账单任务',
      name: 'bills',
    },
    {
      aliases: ['row', 'line', 'lines'],
      description: '账单解析出来的一条条流水，入账前的草稿。',
      label: '账单流水',
      name: 'rows',
    },
  ],
  capabilities: [
    {
      backend: 'firefly',
      command: ['transactions', 'list'],
      description: '按日期区间和类型翻阅交易。',
      examples: [
        {
          command: 'abei transactions list --start 2026-08-01 --end 2026-08-31 --type withdrawal',
          params: {
            end: '2026-08-31',
            start: '2026-08-01',
            type: 'withdrawal',
          },
          title: '看这个月的支出',
        },
      ],
      human_only: [],
      id: 'transactions.list',
      label: '查看交易',
      method: 'GET',
      params: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        description: '`transactions list` 的参数。',
        properties: {
          end: {
            description: '结束日期，格式 YYYY-MM-DD，含当天。',
            type: ['string', 'null'],
          },
          limit: {
            description: '每页条数，1 到 100。',
            format: 'uint32',
            minimum: 0,
            type: ['integer', 'null'],
          },
          page: {
            description: '页码，从 1 开始。',
            format: 'uint32',
            minimum: 0,
            type: ['integer', 'null'],
          },
          start: {
            description: '起始日期，格式 YYYY-MM-DD，含当天。',
            type: ['string', 'null'],
          },
          type: {
            description: '交易类型：withdrawal 支出、deposit 收入、transfer 转账、all 全部。',
            type: ['string', 'null'],
          },
        },
        title: 'TransactionsListParams',
        type: 'object',
      },
      path: '/v1/transactions',
      resource: 'transactions',
      risk: 'read',
      tool_name: 'transactions_list',
      verb: 'list',
    },
    {
      backend: 'firefly',
      command: ['transactions', 'summary'],
      description: '统计区间内的消费：按类型合计、日常消费口径、分类/商户/付款账户排行和每日流水。',
      examples: [
        {
          command: 'abei transactions summary --start 2026-08-01 --end 2026-08-31',
          params: {
            end: '2026-08-31',
            start: '2026-08-01',
          },
          title: '这个月花了多少',
        },
        {
          command:
            'abei transactions summary --start 2026-08-01 --end 2026-08-31 --exclude-category 房租',
          params: {
            end: '2026-08-31',
            exclude_category: ['房租'],
            start: '2026-08-01',
          },
          title: '排除房租再看一次',
        },
      ],
      human_only: [],
      id: 'transactions.summary',
      label: '汇总消费',
      method: 'GET',
      params: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        description: '`transactions summary` 的参数。',
        properties: {
          end: {
            description: '结束日期，格式 YYYY-MM-DD，含当天。',
            type: ['string', 'null'],
          },
          exclude_category: {
            description: '额外排除的分类名，在默认排除表之外追加。',
            items: {
              type: 'string',
            },
            type: ['array', 'null'],
          },
          start: {
            description: '起始日期，格式 YYYY-MM-DD，含当天。',
            type: ['string', 'null'],
          },
        },
        title: 'TransactionsSummaryParams',
        type: 'object',
      },
      path: '/v1/transactions/summary',
      resource: 'transactions',
      risk: 'read',
      tool_name: 'transactions_summary',
      verb: 'summary',
    },
    {
      backend: 'server',
      command: ['bills', 'list'],
      description: '列出收件箱里的账单任务，可按渠道和状态筛选。',
      examples: [
        {
          command: 'abei bills list --status pending',
          params: {
            status: 'pending',
          },
          title: '看还没处理完的账单',
        },
        {
          command: 'abei bills list --source alipay',
          params: {
            source: 'alipay',
          },
          title: '只看支付宝的',
        },
      ],
      human_only: [],
      id: 'bills.list',
      label: '查看账单任务',
      method: 'GET',
      params: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        description: '`bills list` 的参数。',
        properties: {
          limit: {
            description: '每页条数，1 到 100。',
            format: 'uint32',
            minimum: 0,
            type: ['integer', 'null'],
          },
          page: {
            description: '页码，从 1 开始。',
            format: 'uint32',
            minimum: 0,
            type: ['integer', 'null'],
          },
          source: {
            description: '来源渠道，例如 alipay、wechat、cmb、boc。',
            type: ['string', 'null'],
          },
          status: {
            description: '任务状态，例如 pending、needs_secret、failed、imported、ignored。',
            type: ['string', 'null'],
          },
        },
        title: 'BillsListParams',
        type: 'object',
      },
      path: '/v1/bills',
      resource: 'bills',
      risk: 'read',
      tool_name: 'bills_list',
      verb: 'list',
    },
    {
      backend: 'server',
      command: ['bills', 'review'],
      description: '读一份账单已分好桶、脱过敏的审阅视图。改流水之前先看这个，别去逐行拉原始数据。',
      examples: [
        {
          command: 'abei bills review 42',
          params: {
            id: '42',
          },
          title: '审阅第 42 号账单',
        },
      ],
      human_only: [],
      id: 'bills.review',
      label: '审阅账单',
      method: 'GET',
      params: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        description: '只按 id 取一个对象的能力共用这一个参数类型。',
        properties: {
          id: {
            description: '对象 id，正整数。',
            type: 'string',
          },
        },
        required: ['id'],
        title: 'IdParams',
        type: 'object',
      },
      path: '/v1/bills/{id}/review',
      resource: 'bills',
      risk: 'read',
      tool_name: 'bills_review',
      verb: 'review',
    },
    {
      backend: 'abei',
      command: ['bills', 'import'],
      description:
        '把选中的流水写进账本。这一步会真的产生交易，必须人工确认；先干跑一次看会写什么。',
      examples: [
        {
          command: 'abei bills import 42 --all --dry-run',
          params: {
            all: true,
            id: '42',
          },
          title: '先看看会写什么',
        },
        {
          command: 'abei bills import 42 --row-ids 7 --row-ids 8 --yes',
          params: {
            id: '42',
            row_ids: [7, 8],
          },
          title: '确认导入这两行',
        },
      ],
      human_only: [],
      id: 'bills.import',
      label: '导入账单',
      method: 'POST',
      params: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        description: '`bills import` 的参数。all 与 row_ids 二选一。',
        properties: {
          all: {
            description: '导入这份账单里全部待处理的流水。与 row_ids 二选一。',
            type: ['boolean', 'null'],
          },
          id: {
            description: '账单任务 id，正整数。',
            type: 'string',
          },
          include_payload: {
            description: '返回体里带上将要写进账本的完整字段，排障用。',
            type: ['boolean', 'null'],
          },
          row_ids: {
            description: '只导入这些流水行。与 all 二选一。',
            items: {
              format: 'uint64',
              minimum: 0,
              type: 'integer',
            },
            type: ['array', 'null'],
          },
        },
        required: ['id'],
        title: 'BillsImportParams',
        type: 'object',
      },
      path: '/v1/bills/{id}/import',
      resource: 'bills',
      risk: 'confirm',
      tool_name: 'bills_import',
      verb: 'import',
    },
    {
      backend: 'server',
      command: ['bills', 'unlock'],
      description:
        '给加密的账单文件提交打开密码或验证码。密码由人在可信界面输入，不进日志、不回显给模型。',
      examples: [
        {
          command: 'abei bills unlock 42 --secret 这里填密码 --yes',
          params: {
            id: '42',
            secret: '这里填密码',
          },
          title: '提交第 42 号账单的密码（密码由人现敲，模型不要自己编）',
        },
      ],
      human_only: ['secret'],
      id: 'bills.unlock',
      label: '提交账单密码',
      method: 'POST',
      params: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        description: '`bills unlock` 的参数。密码只经手不落日志。',
        properties: {
          id: {
            description: '账单任务 id，正整数。',
            type: 'string',
          },
          secret: {
            description: '账单文件的打开密码或验证码。由人在可信界面输入，不要让模型自己编。',
            type: 'string',
            'x-abei-human-only': true,
          },
        },
        required: ['id', 'secret'],
        title: 'BillsUnlockParams',
        type: 'object',
      },
      path: '/v1/bills/{id}/unlock',
      resource: 'bills',
      risk: 'confirm',
      tool_name: 'bills_unlock',
      verb: 'unlock',
    },
    {
      backend: 'server',
      command: ['bills', 'ignore'],
      description: '把这份账单移出待办队列，不再提示。',
      examples: [
        {
          command: 'abei bills ignore 42 --yes',
          params: {
            id: '42',
          },
          title: '忽略第 42 号账单',
        },
      ],
      human_only: [],
      id: 'bills.ignore',
      label: '忽略账单',
      method: 'POST',
      params: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        description: '只按 id 取一个对象的能力共用这一个参数类型。',
        properties: {
          id: {
            description: '对象 id，正整数。',
            type: 'string',
          },
        },
        required: ['id'],
        title: 'IdParams',
        type: 'object',
      },
      path: '/v1/bills/{id}/ignore',
      resource: 'bills',
      risk: 'confirm',
      tool_name: 'bills_ignore',
      verb: 'ignore',
    },
    {
      backend: 'server',
      command: ['rows', 'update'],
      description:
        '填一条流水该记成什么：类型、日期、金额、摘要、账户、分类、标签。写入一律记成 AI 建议，等人在收件箱确认；银行原文不给改。',
      examples: [
        {
          command: 'abei rows update 7 --firefly-type withdrawal --category-name 餐饮 --yes',
          params: {
            category_name: '餐饮',
            firefly_type: 'withdrawal',
            id: '7',
          },
          title: '把第 7 行记成餐饮支出',
        },
      ],
      human_only: [],
      id: 'rows.update',
      label: '填写账单建议',
      method: 'PATCH',
      params: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        description:
          '`rows update` 的参数。\n\n只开放「这笔该记成什么」这一组字段：银行原文（交易时间、对方、订单号等）不给改，\n那是账单本身说的话。写入一律记成 AI 建议，由人在收件箱确认。',
        properties: {
          category_name: {
            description: '分类名。',
            type: ['string', 'null'],
          },
          destination_name: {
            description: '收款账户名。',
            type: ['string', 'null'],
          },
          firefly_amount: {
            description: '记账金额，正数。',
            type: ['string', 'null'],
          },
          firefly_date: {
            description: '记账日期，格式 YYYY-MM-DD。',
            type: ['string', 'null'],
          },
          firefly_description: {
            description: '记账摘要。',
            type: ['string', 'null'],
          },
          firefly_type: {
            description: '记账类型：withdrawal 支出、deposit 收入、transfer 转账。',
            type: ['string', 'null'],
          },
          id: {
            description: '流水行 id，正整数。',
            type: 'string',
          },
          notes: {
            description: '备注。',
            type: ['string', 'null'],
          },
          source_name: {
            description: '付款账户名。',
            type: ['string', 'null'],
          },
          tags: {
            description: '标签。',
            items: {
              type: 'string',
            },
            type: ['array', 'null'],
          },
        },
        required: ['id'],
        title: 'RowsUpdateParams',
        type: 'object',
      },
      path: '/v1/bill-rows/{id}',
      resource: 'rows',
      risk: 'draft',
      tool_name: 'rows_update',
      verb: 'update',
    },
    {
      backend: 'server',
      command: ['rows', 'split'],
      description: '把一条组合支付的流水拆成两笔以上的草稿，比如一半余额一半银行卡。',
      examples: [
        {
          command:
            'abei rows split 7 --splits amount=30.00,description=餐费,payment_method=余额 --splits amount=15.00,description=餐费,payment_method=招行卡 --yes',
          params: {
            id: '7',
            splits: [
              {
                amount: '30.00',
                description: '餐费',
                payment_method: '余额',
              },
              {
                amount: '15.00',
                description: '餐费',
                payment_method: '招行卡',
              },
            ],
          },
          title: '把第 7 行拆成两笔',
        },
      ],
      human_only: [],
      id: 'rows.split',
      label: '拆分组合支付',
      method: 'POST',
      params: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        additionalProperties: false,
        description: '`rows split` 的参数。',
        properties: {
          id: {
            description: '流水行 id，正整数。',
            type: 'string',
          },
          splits: {
            description: '拆成哪几笔，至少两笔，最多二十笔。',
            items: {
              additionalProperties: false,
              description: '一次拆分里的一笔。',
              properties: {
                amount: {
                  description: '这一笔的金额，正数。',
                  type: 'string',
                },
                category_name: {
                  description: '这一笔的分类名。',
                  type: ['string', 'null'],
                },
                description: {
                  description: '这一笔的摘要，必填——拆出来的每笔都得说清楚是什么。',
                  type: 'string',
                },
                payment_method: {
                  description: '这一笔的收/付款方式。',
                  type: ['string', 'null'],
                },
                source_name: {
                  description: '这一笔的付款账户名。',
                  type: ['string', 'null'],
                },
              },
              required: ['amount', 'description'],
              type: 'object',
            },
            type: 'array',
          },
        },
        required: ['id', 'splits'],
        title: 'RowsSplitParams',
        type: 'object',
      },
      path: '/v1/bill-rows/{id}/split',
      resource: 'rows',
      risk: 'draft',
      tool_name: 'rows_split',
      verb: 'split',
    },
  ],
} as const;

export function catalogFixture(): { version: string; capabilities: AbeiCapability[] } {
  return structuredClone(CATALOG) as unknown as { version: string; capabilities: AbeiCapability[] };
}

export function capability(id: string): AbeiCapability {
  const found = catalogFixture().capabilities.find((item) => item.id === id);
  if (!found) throw new Error(`目录快照里没有 ${id}`);
  return found;
}
