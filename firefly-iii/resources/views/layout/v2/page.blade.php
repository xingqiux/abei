{{-- 独立页面布局，用于错误页和邮件链接的落地页。
     后端已无前端资源，这里不引用任何构建产物或 web 路由，样式全部内联。 --}}
    <!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">
<head>
    @php
        $statusCode = trim($__env->yieldContent('status_code'));
        $statusText = trim($__env->yieldContent('status'));
        $errorTitle = trim($statusCode.' '.$statusText);
    @endphp
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow, noarchive">
    <meta name="color-scheme" content="light dark">
    <title>{{ '' === $errorTitle ? '谷仓' : $errorTitle.' - 谷仓' }}</title>
    <style>
        :root {
            color-scheme: light dark;
            --bg: #f9fafb;
            --surface: #ffffff;
            --border: #e5e7eb;
            --ink: #111827;
            --ink-2: #6b7280;
            --accent: #4f46e5;
        }

        @media (prefers-color-scheme: dark) {
            :root {
                --bg: #111827;
                --surface: #1f2937;
                --border: #374151;
                --ink: #f9fafb;
                --ink-2: #9ca3af;
                --accent: #818cf8;
            }
        }

        * { box-sizing: border-box; }

        body {
            margin: 0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            background: var(--bg);
            color: var(--ink);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
            "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
            font-size: 14px;
            line-height: 1.6;
        }

        main {
            width: 100%;
            max-width: 640px;
            padding: 32px;
            border: 1px solid var(--border);
            border-radius: 12px;
            background: var(--surface);
        }

        .code { font-size: 40px; font-weight: 600; letter-spacing: -0.02em; }

        .status { margin-top: 4px; font-size: 16px; font-weight: 500; }

        .sub { margin-top: 8px; color: var(--ink-2); }

        .body { margin-top: 20px; }

        .body p { margin: 0 0 12px; }

        .body p:last-child { margin-bottom: 0; }

        pre {
            overflow-x: auto;
            padding: 12px;
            border: 1px solid var(--border);
            border-radius: 8px;
            background: var(--bg);
            font-size: 12px;
        }

        a { color: var(--accent); }

        table { width: 100%; border-collapse: collapse; }

        td, th { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; }
    </style>
</head>
<body>
<main>
    @if('' !== $statusCode)
        <div class="code">{{ $statusCode }}</div>
    @endif
    @if('' !== $statusText)
        <div class="status">{{ $statusText }}</div>
    @endif
    @hasSection('sub_title')
        <div class="sub">@yield('sub_title')</div>
    @endif
    <div class="body">
        @yield('content')
    </div>
</main>
</body>
</html>
