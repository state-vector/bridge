/** shim — Top moved into @bridge/ui-kit; the webapp injects its live
 *  hub-plane ask feed so the ask band shows the WS decisions too. */
import { TopView as KitTopView } from "@bridge/ui-kit";
import { useBridge } from "../lib/store";

export function TopView() {
  const decisions = useBridge((s) => s.decisions);
  const resolve = useBridge((s) => s.resolve);
  return <KitTopView askFeed={{ decisions, resolve }} />;
}
