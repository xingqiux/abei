import { formatSignedAmount, semanticColorClass, type MoneySemantic } from '../../lib/format'
import { usePrivacyStore } from '../../store/privacyStore'

export function MoneyText({
  value,
  semantic,
  symbol = '¥',
  className = '',
}: {
  value: number | string
  semantic: MoneySemantic
  symbol?: string
  className?: string
}) {
  const hidden = usePrivacyStore((s) => s.hidden)
  const text = formatSignedAmount(value, semantic, symbol)

  return (
    <span
      className={`num ${semanticColorClass(semantic)} ${className}`}
      /* 隐私模式下真值完全不进 DOM——文本、aria-label、title 都不留。
         读屏用户开隐私模式同样是不想让金额被听见/被旁人看见，
         留个「无障碍后门」等于这个开关白做。要看数就先关掉隐私模式。 */
      aria-label={hidden ? '金额已隐藏' : text}
      title={hidden ? undefined : text}
    >
      {hidden ? '••••' : text}
    </span>
  )
}
