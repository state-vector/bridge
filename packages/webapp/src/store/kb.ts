/** shim — the kb store moved into @bridge/ui-kit. The webapp wires its
 *  sign-in gate (useBridge conn=auth) as the auth escalator. */
import { setKbAuthEscalator } from "@bridge/ui-kit";
import { useBridge } from "../lib/store";

setKbAuthEscalator(() => useBridge.setState({ conn: "auth" }));

export { useKb, kbConnected, type BoardPrefs } from "@bridge/ui-kit";
