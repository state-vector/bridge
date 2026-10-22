/** shim — For Me moved into @bridge/ui-kit; the webapp injects its live
 *  hub-plane ask feed (decisions WS + resolve). */
import { ForMeView as KitForMeView } from "@bridge/ui-kit";
import { useBridge } from "../lib/store";

export function ForMeView(props: { openThread?: (taskId: string) => void }) {
  const decisions = useBridge((s) => s.decisions);
  const resolve = useBridge((s) => s.resolve);
  return <KitForMeView {...props} askFeed={{ decisions, resolve }} />;
}
