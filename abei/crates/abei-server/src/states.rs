//! 四张表的状态机，写成 Rust 类型。
//!
//! 这些状态原先只以两种形式存在：库里的 CHECK 约束，和散在几十处 SQL 里的字符串字面量。
//! 于是「哪些状态合法」要翻 migration，「哪些迁移合法」根本没人写下来——`sending` 能不能
//! 直接跳 `reconciled`、`retryable` 之后还能不能改，全靠读代码猜。
//!
//! 这里把两件事都落成类型：
//! - [`ImportStatus`] 等枚举穷举合法状态，`from_str` 拒绝库里不该出现的值；
//! - `can_transition` 写下合法迁移，配套用例锁住它，改状态机时先改这里。
//!
//! SQL 仍然写字符串（Postgres 那头是 text 列），但字面量统一由 `as_str` / `sql_list`
//! 渲染出来，不再手抄。库里的 CHECK 约束是最后一道防线，本次不动。

use std::fmt;

/// 把一组状态渲染成能直接塞进 `IN (...)` 的 SQL 片段，例如 `'queued', 'running'`。
///
/// 状态名都是我们自己定义的 ASCII 标识符，不含引号，拼进 SQL 不构成注入面。
pub(crate) fn sql_list<T: State>(states: &[T]) -> String {
    states
        .iter()
        .map(|state| format!("'{}'", state.as_str()))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 枚举共有的行为。让 [`sql_list`] 之类的工具不用对每个枚举各写一遍。
pub(crate) trait State: Copy {
    fn as_str(&self) -> &'static str;
}

/// 定义一个状态枚举：变体、对应的库内字面量、以及合法迁移。
macro_rules! define_state {
    (
        $(#[$meta:meta])*
        $name:ident {
            $($variant:ident = $literal:literal => [$($target:ident),* $(,)?]),* $(,)?
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        // 状态机要写全才有意义：库里存在的状态就该有对应的变体，哪怕当前没有 Rust
        // 代码去写它（有些状态只由 SQL 读到）。同理每个枚举都拿到全套 ALL /
        // can_transition / is_terminal，用不用得上看各自的调用点。缺了变体才是 bug，
        // 多了不是——所以这里不让 dead_code 逼着我们把状态机写残。
        // 完整性由本文件的用例保证，不是靠 dead_code 检查。
        #[allow(dead_code, reason = "状态机按库内约束写全，不按当前调用点裁剪")]
        pub(crate) enum $name {
            $($variant),*
        }

        #[allow(dead_code, reason = "同上：全套访问器是状态机的定义，不是调用点的产物")]
        impl $name {
            /// 库里存的字面量，和 CHECK 约束逐字对应。
            pub(crate) const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $literal),*
                }
            }

            /// 全部合法状态，顺序即声明顺序。
            pub(crate) const ALL: &'static [Self] = &[$(Self::$variant),*];

            /// 从库里读回来的字符串解析成状态。认不出来说明库里有 CHECK 拦不住的脏数据，
            /// 或者迁移加了状态但这里忘了跟——两种都该炸出来而不是当成默认值。
            pub(crate) fn from_str(value: &str) -> Option<Self> {
                match value {
                    $($literal => Some(Self::$variant),)*
                    _ => None,
                }
            }

            /// 从这个状态出发能合法走到哪些状态。
            pub(crate) const fn next_states(self) -> &'static [Self] {
                match self {
                    $(Self::$variant => &[$(Self::$target),*]),*
                }
            }

            /// 这一步迁移合不合法。终态返回 false（迁移到自己也是 false）。
            pub(crate) fn can_transition(self, to: Self) -> bool {
                self.next_states().contains(&to)
            }

            /// 没有任何出边的状态。到这里流程就结束了，再要动只能新开一条记录。
            pub(crate) fn is_terminal(self) -> bool {
                self.next_states().is_empty()
            }
        }

        impl State for $name {
            fn as_str(&self) -> &'static str {
                (*self).as_str()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

define_state! {
    /// `abei_ai.bill_import_attempts.status`：一条流水写进 Firefly 的整个过程。
    ///
    /// 关键的一条是 `sending` → `uncertain`：请求发出去了但没收到回应，我们不知道
    /// Firefly 那边到底建没建。这时候唯一安全的动作是拿 `external_id` 回查对账，
    /// 绝不能当失败直接重发，否则用户账本上多一笔。
    ///
    /// `retryable` 和几个终态都没有出边：重试的做法是给同一行新开一条 `attempt_no + 1`
    /// 的记录，而不是把旧记录改回 `prepared`。库里那两个部分唯一索引
    /// （active / success）就是按这个前提建的。
    ImportStatus {
        Prepared = "prepared" => [Sending, Retryable, Rejected],
        Sending = "sending" => [Succeeded, Rejected, Retryable, Uncertain],
        Uncertain = "uncertain" => [Succeeded, Reconciled, Retryable],
        Succeeded = "succeeded" => [],
        Reconciled = "reconciled" => [],
        Rejected = "rejected" => [],
        Retryable = "retryable" => [],
    }
}

impl ImportStatus {
    /// 占着这一行、不让新流水开工的状态。对应部分唯一索引 `bill_import_attempts_active_row_idx`。
    pub(crate) const ACTIVE: &'static [Self] = &[Self::Prepared, Self::Sending, Self::Uncertain];

    /// 算数已经落定的状态，对应 `bill_import_attempts_success_row_idx`。
    pub(crate) const SETTLED: &'static [Self] = &[Self::Succeeded, Self::Reconciled];
}

define_state! {
    /// `abei_ai.parse_jobs.status`：一封邮件解析成流水的过程。
    ///
    /// `waiting_input` 是解析器要用户补信息（例如账单密码）时停住的地方，补完回到 `running`。
    ParseJobStatus {
        Queued = "queued" => [Running, Cancelled],
        Running = "running" => [Succeeded, Failed, WaitingInput, Cancelled],
        WaitingInput = "waiting_input" => [Running, Failed, Cancelled],
        Succeeded = "succeeded" => [],
        Failed = "failed" => [],
        Cancelled = "cancelled" => [],
    }
}

define_state! {
    /// `abei_ai.mail_sync_runs.status`：一次收邮件。
    ///
    /// `queued` 能直接到 `failed`，因为清扫器回收失去心跳的任务时不管它跑没跑起来。
    SyncRunStatus {
        Queued = "queued" => [Running, Failed, Cancelled],
        Running = "running" => [Succeeded, Failed, Cancelled],
        Succeeded = "succeeded" => [],
        Failed = "failed" => [],
        Cancelled = "cancelled" => [],
    }
}

impl SyncRunStatus {
    /// 还没收尾的状态，清扫器和「同一用户只能有一个同步在跑」的判断都认这一组。
    pub(crate) const IN_FLIGHT: &'static [Self] = &[Self::Queued, Self::Running];

    /// 渲染成 `IN (...)` 用的片段。
    pub(crate) fn in_flight_sql() -> String {
        sql_list(Self::IN_FLIGHT)
    }
}

define_state! {
    /// `abei_ai.bill_rows.status`：一行流水在收件箱里的去向。
    ///
    /// `imported` 没有出边——账已经在 Firefly 里了，撤销要走 Firefly 那边删除，
    /// 不是把这一行改回 `pending`。
    RowStatus {
        Pending = "pending" => [Imported, Dismissed],
        Dismissed = "dismissed" => [Pending],
        Imported = "imported" => [],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_status_survives_a_round_trip_through_its_literal() {
        for status in ImportStatus::ALL {
            assert_eq!(ImportStatus::from_str(status.as_str()), Some(*status));
        }
        for status in ParseJobStatus::ALL {
            assert_eq!(ParseJobStatus::from_str(status.as_str()), Some(*status));
        }
        for status in SyncRunStatus::ALL {
            assert_eq!(SyncRunStatus::from_str(status.as_str()), Some(*status));
        }
        for status in RowStatus::ALL {
            assert_eq!(RowStatus::from_str(status.as_str()), Some(*status));
        }
    }

    #[test]
    fn an_unknown_literal_is_rejected_instead_of_silently_becoming_a_default() {
        assert_eq!(ImportStatus::from_str("Prepared"), None);
        assert_eq!(ImportStatus::from_str("in_flight"), None);
        assert_eq!(ImportStatus::from_str(""), None);
        assert_eq!(RowStatus::from_str("imported "), None);
    }

    #[test]
    fn a_sending_import_can_only_land_somewhere_that_keeps_the_ledger_honest() {
        use ImportStatus::*;
        // 发出去之后要么有结果，要么进 uncertain 等对账。
        assert!(Sending.can_transition(Succeeded));
        assert!(Sending.can_transition(Rejected));
        assert!(Sending.can_transition(Retryable));
        assert!(Sending.can_transition(Uncertain));
        // 不能凭空宣布已对账——reconciled 只能从 uncertain 走查证之后来。
        assert!(!Sending.can_transition(Reconciled));
        assert!(Uncertain.can_transition(Reconciled));
        // 也不能退回去重发：重试要新开一条 attempt。
        assert!(!Sending.can_transition(Prepared));
        assert!(!Retryable.can_transition(Prepared));
    }

    #[test]
    fn the_terminal_states_are_exactly_the_ones_we_think_they_are() {
        use ImportStatus::*;
        assert!(Succeeded.is_terminal());
        assert!(Reconciled.is_terminal());
        assert!(Rejected.is_terminal());
        assert!(Retryable.is_terminal());
        assert!(!Prepared.is_terminal());
        assert!(!Sending.is_terminal());
        assert!(!Uncertain.is_terminal());

        assert!(RowStatus::Imported.is_terminal());
        assert!(!RowStatus::Dismissed.is_terminal());
    }

    #[test]
    fn no_state_can_transition_to_itself() {
        for status in ImportStatus::ALL {
            assert!(!status.can_transition(*status), "{status} 迁移到自己");
        }
        for status in ParseJobStatus::ALL {
            assert!(!status.can_transition(*status), "{status} 迁移到自己");
        }
        for status in SyncRunStatus::ALL {
            assert!(!status.can_transition(*status), "{status} 迁移到自己");
        }
        for status in RowStatus::ALL {
            assert!(!status.can_transition(*status), "{status} 迁移到自己");
        }
    }

    #[test]
    fn the_active_and_settled_groups_match_the_partial_unique_indexes() {
        // 这两组必须和 migration 里那两个部分唯一索引逐字一致，否则「一行同时只能有一条
        // 在途流水」的保证会从库层面漏掉。
        assert_eq!(
            sql_list(ImportStatus::ACTIVE),
            "'prepared', 'sending', 'uncertain'"
        );
        assert_eq!(sql_list(ImportStatus::SETTLED), "'succeeded', 'reconciled'");
        assert_eq!(SyncRunStatus::in_flight_sql(), "'queued', 'running'");
    }
}
