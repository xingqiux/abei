/** Abaku 算珠主标志：算盘的一根档。用 currentColor，颜色由使用处决定。 */
export function AbakuMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <path d="M12 2.8v18.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M4.6 10.4h14.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <rect x="8" y="4.8" width="8" height="3.2" rx="1.6" fill="currentColor" />
      <rect x="8" y="13.2" width="8" height="3.2" rx="1.6" fill="currentColor" />
      <rect x="8" y="17.4" width="8" height="3.2" rx="1.6" fill="currentColor" />
    </svg>
  )
}
