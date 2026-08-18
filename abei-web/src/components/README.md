# 组件层：与另一端同步维护

`abei-web/src/components/` 和 `abei-admin/src/components/` 下有一组**逐字节相同**的文件。
它们不是复制粘贴的历史残留，是有意的镜像：两端各自独立构建、独立部署，
抽 workspace 包要动两边的构建配置和发布流程，风险大于收益，所以先靠约定维护。

**改其中任何一个，必须把另一端改成一模一样。** 校验方法：

```sh
for f in ui/Button.tsx ui/Card.tsx ui/Badge.tsx ui/Field.tsx ui/Dropdown.tsx ui/SegmentedControl.tsx \
         abei/AbeiMark.tsx abei/ConfirmDialog.tsx abei/EmptyState.tsx abei/ErrorState.tsx \
         abei/LottieIcon.tsx abei/Modal.tsx abei/ProgressBar.tsx abei/StatusChip.tsx \
         abei/useDialogBehavior.ts tokenEvents.ts; do
  diff -q "abei-web/src/components/$f" "abei-admin/src/components/$f" || echo "分叉：$f"
done
```

## 有意分叉的几个

| 文件 | 为什么不一样 |
| --- | --- |
| `abei/Toast.tsx` | 进场动画：前台用 GSAP（本来就依赖它），后台只有这一处动效，用 index.css 的 `toast-in` 关键帧，不为它引一个动画库。**行为已对齐**：层级都是 `z-[210]`，压过 `Modal` 的 `z-200`。 |
| `TokenGate.tsx` | 两端的令牌来源与失效处理不同（后台还有 OwnerGate 这一层）。 |
| `ui/Tabs.tsx` | 后台的 tab 不带徽标计数。 |
| `layout/` | 壳完全不同：前台是侧栏 + 底部 tab + Cmd+K，后台是左窄栏 + 顶栏。 |
