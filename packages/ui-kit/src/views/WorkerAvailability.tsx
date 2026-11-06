import { useEffect, useState } from "react";
import { currentWorkerStatus } from "@bridge/contracts";
import { useKb } from "../server/kbStore";

export function useWorkerStatus() {
  const workers = useKb(s => s.workers);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  return workers?.map(worker => currentWorkerStatus(worker, now)) ?? null;
}

export function WorkerAvailabilityBanner() {
  const workers = useWorkerStatus();
  const connected = useKb(s => s.conn === "open");
  if (!connected || workers === null || workers.some(worker => worker.state === "ready" || worker.state === "busy")) return null;
  return <div className="worker-warning" role="status"><strong>No workers available.</strong> Automated work will resume when a worker is ready. See worker status in the header.</div>;
}
