import { Link } from '@tanstack/react-router'

export function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <p className="text-lg font-semibold text-[var(--text-primary)]">这个页面不在了</p>
      <p className="max-w-sm text-sm text-[var(--text-secondary)]">
        地址可能拼错了。后台只有邮件、解析器、反馈三个页面。
      </p>
      <Link
        to="/mail"
        className="mt-1 inline-flex items-center rounded-md bg-[var(--brand)] px-3 py-1.5 text-[13px] font-semibold text-[var(--brand-on)]"
      >
        去邮件工作台
      </Link>
    </div>
  )
}
