import { useCommandPaletteStore } from './commandPaletteStore'
import { useDateRangeStore } from './dateRangeStore'
import { useMoreSheetStore } from './moreSheetStore'
import { useRecordTxStore } from './recordTxStore'
import { useToastStore } from './toastStore'

export function resetUserScopedState(): void {
  useRecordTxStore.getState().close()
  useCommandPaletteStore.getState().close()
  useMoreSheetStore.getState().close()
  useToastStore.getState().clear()
  useDateRangeStore.getState().reset()
}
