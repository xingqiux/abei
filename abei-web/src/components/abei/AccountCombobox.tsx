import { useCallback, useMemo } from 'react'
import { Combobox, type ComboboxItem } from './Combobox'

export interface AccountOption {
  id: string
  name: string
}

/** 下拉里最多摆这么多条，再多就该靠输入过滤了 */
const MAX_ITEMS = 20

/**
 * 资产账户选择器。原生 `<select>` 在账户上二十个之后就没法用了——只能一行行滚，
 * 不能打字过滤；这里换成 `Combobox`，候选来自已加载的账户列表，本地过滤，不发请求。
 *
 * 输入框里的文本和选中的账户 id 是两件事，都由调用方持有：
 * 名字对上了才给 id，对不上就给空串，于是「打了半个名字就提交」会被表单校验拦下来，
 * 而不是悄悄提交一个上一次选中的 id。
 */
export function AccountCombobox({
  accounts,
  text,
  onChange,
  isLoading = false,
  placeholder = '输入账户名筛选…',
  hasError,
  'aria-label': ariaLabel,
}: {
  accounts: AccountOption[]
  /** 输入框里的文本 */
  text: string
  /** (输入文本, 精确匹配到的账户 id，没匹配上是空串) */
  onChange: (text: string, accountId: string) => void
  isLoading?: boolean
  placeholder?: string
  hasError?: string
  'aria-label'?: string
}) {
  const items: ComboboxItem[] = useMemo(() => {
    const q = text.trim().toLowerCase()
    const matched = q === '' ? accounts : accounts.filter((a) => a.name.toLowerCase().includes(q))
    return matched.slice(0, MAX_ITEMS).map((a) => ({ id: a.id, label: a.name }))
  }, [accounts, text])

  // 本地过滤，没有请求要发；Combobox 的防抖回调在这里是空转
  const noopQuery = useCallback(() => {}, [])

  return (
    <Combobox
      value={text}
      onChange={(next) => {
        const exact = accounts.find((a) => a.name.toLowerCase() === next.trim().toLowerCase())
        onChange(next, exact?.id ?? '')
      }}
      onDebouncedQuery={noopQuery}
      items={items}
      isLoading={isLoading}
      placeholder={placeholder}
      hasError={hasError}
      aria-label={ariaLabel}
    />
  )
}
