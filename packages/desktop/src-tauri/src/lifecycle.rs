//! Gateway-local orchestration, not another scheduler. The hub alone grants
//! reservations/fences. This registry is the sole owner of local phase/jobs.
//! No network, Git, process wait or callback runs on the controller thread.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Ticket { pub task_id: String, pub session: String }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Ownership {
    Reservation { ticket: Ticket },
    Attempt { ticket: Ticket, host: String, generation: u64, attempt_id: String },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriterReceiptSource { Quiesce, Stopped, Finalize }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleasedWriterPhase { Quiesced }
#[derive(Clone, Serialize, Deserialize)]
pub struct ReleasedWriterProof {
    pub host: String, pub session: String, pub generation: u64, pub attempt_id: String,
    pub phase: ReleasedWriterPhase, pub writers: super::attempt_journal::WriterProof,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WriterReceipt {
    WriterReceiptMissing,
    WriterReceiptHeld { reason: String },
    WriterReceiptFound { task_id: String, command_id: String, source: WriterReceiptSource, proof: ReleasedWriterProof },
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Condvar, Mutex};
    struct Gate(Arc<(Mutex<bool>, Condvar)>);
    impl Clone for Gate { fn clone(&self) -> Self { Self(self.0.clone()) } }
    impl Gate {
        fn new() -> Self { Self(Arc::new((Mutex::new(false), Condvar::new()))) }
        fn wait(&self) { let (lock, cv) = &*self.0; let open = lock.lock().unwrap(); let _ = cv.wait_timeout_while(open, Duration::from_secs(5), |open| !*open).unwrap(); }
        fn open(&self) { let (lock, cv) = &*self.0; *lock.lock().unwrap() = true; cv.notify_all(); }
    }
    fn ticket(id: &str) -> Ticket { Ticket { task_id: id.into(), session: format!("session-{id}") } }
    fn owner(t: &Ticket) -> Ownership { Ownership::Attempt { ticket: t.clone(), host: "host".into(), generation: 1, attempt_id: format!("attempt-{}", t.session) } }
    #[test]
    fn historical_writer_receipt_matches_shared_contract_and_exact_original_owner() {
        let cases:Vec<serde_json::Value>=serde_json::from_str(include_str!("../../../contracts/fixtures/writer-receipts.json")).unwrap();
        let owner=Ownership::Attempt {ticket:Ticket {task_id:"old-task".into(),session:"old-session".into()},host:"original-host".into(),generation:1,attempt_id:"old-attempt".into()};
        for value in &cases {
            let receipt:WriterReceipt=serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(&receipt).unwrap(),*value);
            assert_eq!(Released::from_writer_receipt(&owner,&receipt).is_ok(),value["kind"]=="writer_receipt_found");
        }
        let good=cases.last().unwrap();
        for key in ["host","session","attempt_id"] {
            let mut bad=good.clone();bad["proof"][key]=serde_json::json!("someone-else");
            assert!(Released::from_writer_receipt(&owner,&serde_json::from_value(bad).unwrap()).is_err());
        }
        let mut bad=good.clone();bad["proof"]["generation"]=serde_json::json!(2);
        assert!(Released::from_writer_receipt(&owner,&serde_json::from_value(bad).unwrap()).is_err());
        let mut bad=good.clone();bad["task_id"]=serde_json::json!("another-task");
        assert!(Released::from_writer_receipt(&owner,&serde_json::from_value(bad).unwrap()).is_err());
        for (key,value) in [("phase","running"),("writers","not_launched")] {
            let mut bad=good.clone();bad["proof"][key]=serde_json::json!(value);
            assert!(serde_json::from_value::<WriterReceipt>(bad).is_err());
        }
    }
    #[test]
    fn reservation_release_requires_complete_authoritative_claim_facts() {
        let ticket = ticket("reservation");
        let owner = Ownership::Reservation { ticket: ticket.clone() };
        for task in [
            serde_json::json!({"id":ticket.task_id}),
            serde_json::json!({"id":ticket.task_id,"status":"unknown","meta":{}}),
            serde_json::json!({"id":ticket.task_id,"status":"blocked"}),
            serde_json::json!({"id":ticket.task_id,"status":"in_progress","meta":{}}),
            serde_json::json!({"id":ticket.task_id,"status":"in_progress","meta":{"session":""}}),
            serde_json::json!({"id":ticket.task_id,"status":"in_progress","meta":{"session":ticket.session}}),
            serde_json::json!({"id":"other","status":"blocked","meta":{}}),
        ] { assert!(Released::reservation_reconciled(&owner, &task).is_err(), "incomplete/unchanged facts released the reservation: {task}"); }
        for task in [
            serde_json::json!({"id":ticket.task_id,"status":"blocked","meta":{}}),
            serde_json::json!({"id":ticket.task_id,"status":"in_progress","meta":{"session":"new-owner"}}),
        ] { assert!(Released::reservation_reconciled(&owner, &task).is_ok()); }
    }
    fn release(owner: &Ownership) -> Released {
        let reply = match owner {
            Ownership::Reservation { ticket } => serde_json::json!({"kind":"released","task_id":ticket.task_id}),
            Ownership::Attempt { ticket, host, generation, attempt_id } => serde_json::json!({"attempt":{
                "phase":"quiesced","host":host,"generation":generation,"attempt_id":attempt_id,"session":ticket.session}}),
        };
        Released::from_hub(owner, &reply).unwrap()
    }
    fn pump<P: Send + 'static, R: Send + 'static, F: Send + 'static>(p: &mut Pipeline<P, R, F>, until: impl Fn(&Pipeline<P, R, F>) -> bool,
        mut complete: impl FnMut(&mut R) -> Option<F>) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !until(p) {
            p.poll(&mut complete);
            assert!(Instant::now() < deadline, "pipeline did not make progress: {:?}", p.counts());
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    #[test]
    fn one_blocked_preparation_cannot_serialize_the_other_nineteen_slots() {
        let gate = Gate::new(); let blocked = gate.clone();
        let mut p = Pipeline::new(20, 4, 4,
            move |t: Ticket, _: Arc<AtomicBool>| { if t.task_id == "00" { blocked.wait(); } Prepared::Running { owner: owner(&t), value: t } },
            |o: Ownership, report| { report.released(release(&o)); Finished::Complete });
        for n in 0..20 { assert!(p.admit(ticket(&format!("{n:02}")), ticket(&format!("{n:02}"))).is_ok()); }
        pump(&mut p, |p| p.counts().running == 19, |_| None);
        assert_eq!(p.counts().preparing, 1);
        assert_eq!(p.counts().charged, 20);
        gate.open();
        pump(&mut p, |p| p.counts().running == 20, |_| None);
        p.drain();
        pump(&mut p, |p| p.is_idle(), |t| Some(owner(t)));
    }
    #[test]
    fn slow_delivery_does_not_consume_released_execution_capacity() {
        let gate = Gate::new(); let blocked = gate.clone();
        let mut p = Pipeline::new(4, 2, 2,
            |t: Ticket, _: Arc<AtomicBool>| Prepared::Running { owner: owner(&t), value: t },
            move |o: Ownership, report| { report.released(release(&o)); if o.ticket().task_id == "old" { blocked.wait(); } Finished::Complete });
        assert!(p.admit(ticket("old"), ticket("old")).is_ok());
        pump(&mut p, |p| p.counts().delivering == 1, |t| Some(owner(t)));
        assert!(!p.is_idle(), "an update must wait for outstanding delivery/effects");
        for n in 0..4 { let t = ticket(&format!("new{n}")); assert!(p.admit(t.clone(), t).is_ok()); }
        pump(&mut p, |p| p.counts().running == 4, |_| None);
        assert_eq!(p.counts().delivering, 1);
        gate.open(); p.drain();
        pump(&mut p, |p| p.is_idle(), |t| Some(owner(t)));
    }
    #[test]
    fn duplicate_or_late_fences_never_create_two_writers_or_free_another_attempt() {
        let mut p = Pipeline::new(2, 2, 2,
            |t: Ticket, _: Arc<AtomicBool>| Prepared::Running { owner: owner(&t), value: t },
            |_: Ownership, report| { report.released(release(&owner(&ticket("wrong")))); Finished::Complete });
        let first = ticket("same");
        assert!(p.admit(first.clone(), first.clone()).is_ok());
        assert!(p.admit(first.clone(), first.clone()).is_err());
        let next = Ticket { task_id: first.task_id.clone(), session: "next-session".into() };
        assert!(p.admit(next.clone(), next).is_ok());
        pump(&mut p, |p| p.counts().running == 1, |_| None);
        assert_eq!(p.counts().reserved, 1, "next session must wait for the old local owner");
        pump(&mut p, |p| p.counts().held == 1, |t| Some(owner(t)));
        assert_eq!(p.counts().charged, 2);
        assert!(!p.is_idle());
    }
    #[test]
    fn panic_and_drain_retain_ownership_until_real_finalization_receipts() {
        let gate = Gate::new(); let blocked = gate.clone();
        let spawned = Arc::new(AtomicBool::new(false)); let did_spawn = spawned.clone();
        let mut p = Pipeline::new(2, 1, 1,
            move |t: Ticket, cancel: Arc<AtomicBool>| {
                blocked.wait();
                if cancel.load(Ordering::SeqCst) { Prepared::Finalize { owner: Ownership::Reservation { ticket: t.clone() }, value: Ownership::Reservation { ticket: t } } }
                else { did_spawn.store(true, Ordering::SeqCst); Prepared::Running { owner: owner(&t), value: t } }
            }, |o: Ownership, report| { report.released(release(&o)); Finished::Complete });
        assert!(p.admit(ticket("cancel"), ticket("cancel")).is_ok());
        p.poll(|_| None); p.drain();
        assert!(!p.can_admit()); assert!(!p.is_idle());
        gate.open(); pump(&mut p, |p| p.is_idle(), |_| None);
        assert!(!spawned.load(Ordering::SeqCst));
        let mut failed = Pipeline::new(2, 2, 1,
            |_: Ticket, _: Arc<AtomicBool>| -> Prepared<Ticket, Ownership> { panic!("injected preparation crash"); },
            |_: Ownership, _| Finished::Complete);
        assert!(failed.admit(ticket("panic"), ticket("panic")).is_ok());
        pump(&mut failed, |p| p.counts().held == 1, |_| None);
        assert_eq!(failed.counts().charged, 1);
        assert!(!failed.is_idle());
    }
}
impl Ownership {
    pub fn ticket(&self) -> &Ticket { match self { Self::Reservation { ticket } | Self::Attempt { ticket, .. } => ticket } }
}

/// Only an exact authenticated hub receipt releases a charge. An expired lease,
/// subprocess exit, local stop request or successful checkpoint does not.
pub struct Released(Ownership);
impl Released {
    pub fn owner(&self) -> &Ownership { &self.0 }
    pub fn from_writer_receipt(owner: &Ownership, receipt: &WriterReceipt) -> Result<Self, String> {
        if let (Ownership::Attempt { ticket, host, generation, attempt_id },
            WriterReceipt::WriterReceiptFound { task_id, command_id, proof, .. }) = (owner, receipt) {
            if task_id == &ticket.task_id && !command_id.is_empty() && proof.host == *host
                && proof.session == ticket.session && proof.generation == *generation && proof.attempt_id == *attempt_id {
                return Ok(Self(owner.clone()));
            }
        }
        Err("Stopped-job receipt does not cover this exact original owner".into())
    }
    pub fn reservation_reconciled(owner: &Ownership, task: &serde_json::Value) -> Result<Self, String> {
        let Ownership::Reservation { ticket } = owner else { return Err("not an unlaunched reservation".into()); };
        let status = task["status"].as_str();
        let known_status = matches!(status, Some("todo" | "in_progress" | "in_review" | "blocked" | "done" | "superseded"));
        let claim_changed = match status {
            Some("in_progress") => task["meta"]["session"].as_str().is_some_and(|session| !session.is_empty() && session != ticket.session),
            _ => known_status,
        };
        if task["id"] == ticket.task_id && task["meta"].is_object() && claim_changed {
            Ok(Self(owner.clone()))
        } else { Err("reservation still belongs to this executor".into()) }
    }
    pub fn from_hub(owner: &Ownership, reply: &serde_json::Value) -> Result<Self, String> {
        let matches = match owner {
            Ownership::Reservation { ticket } => reply["kind"] == "released" && reply["task_id"] == ticket.task_id,
            Ownership::Attempt { ticket, host, generation, attempt_id } => {
                let a = &reply["attempt"];
                (a["phase"] == "quiesced" || (a["phase"] == "finalizing" && matches!(a["writers"].as_str(), Some("process_group_empty" | "no_live_group_members"))))
                    && a["host"] == *host && a["session"] == ticket.session
                    && a["generation"] == *generation && a["attempt_id"] == *attempt_id
            }
        };
        if matches { Ok(Self(owner.clone())) } else { Err("release receipt does not cover the exact owner/fence".into()) }
    }
}

pub enum Prepared<R, F> {
    Running { owner: Ownership, value: R },
    Finalize { owner: Ownership, value: F },
}
pub enum Finished<F> {
    Complete,
    Retry { value: F, after: Duration },
    Held { value: F, reason: String },
}
pub struct Reporter(mpsc::Sender<FinalEvent>);
impl Reporter { pub fn released(&self, receipt: Released) { let _ = self.0.send(FinalEvent::Released(receipt.0)); } }
enum FinalEvent { Released(Ownership) }

pub(super) struct Job<T> { rx: mpsc::Receiver<Result<T, String>>, thread: Option<std::thread::JoinHandle<()>> }
impl<T: Send + 'static> Job<T> {
    pub(super) fn start(work: impl FnOnce() -> T + Send + 'static) -> Self {
        let (tx, rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
                .map_err(|_| "background lifecycle operation panicked; ownership retained".to_string());
            let _ = tx.send(result);
        });
        Self { rx, thread: Some(thread) }
    }
    pub(super) fn poll(&mut self) -> Option<Result<T, String>> {
        match self.rx.try_recv() {
            Ok(result) => { if let Some(thread) = self.thread.take() { let _ = thread.join(); } Some(result) },
            Err(mpsc::TryRecvError::Empty) => None,
            Err(mpsc::TryRecvError::Disconnected) => Some(Err("lifecycle operation lost its result; ownership retained".into())),
        }
    }
}
impl<T> Drop for Job<T> {
    fn drop(&mut self) {
        // Dropping a controller is not proof of writer quiescence. Join its
        // bounded I/O job rather than abandon a preparation/publication thread.
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}

enum Phase<P, R, F> {
    Reserved(P),
    Preparing(Job<Prepared<R, F>>),
    Running(R),
    FinalizationQueued { value: F, not_before: Instant },
    Finalizing { job: Job<Finished<F>>, events: mpsc::Receiver<FinalEvent> },
    Held { value: Option<F>, reason: String },
}
struct Entry<P, R, F> { owner: Ownership, charged: bool, cancel: Arc<AtomicBool>, phase: Phase<P, R, F> }

#[derive(Default, Debug, Clone, Serialize)]
pub struct Counts {
    pub reserved: usize, pub preparing: usize, pub running: usize,
    pub finalizing: usize, pub delivering: usize, pub held: usize, pub charged: usize,
}
#[derive(PartialEq, Eq)]
enum Mode { Open, Draining, Stopping }

pub struct Pipeline<P, R, F> {
    entries: BTreeMap<Ticket, Entry<P, R, F>>,
    capacity: usize, preparations: usize, finalizations: usize,
    mode: Mode,
    prepare: Arc<dyn Fn(P, Arc<AtomicBool>) -> Prepared<R, F> + Send + Sync>,
    finalize: Arc<dyn Fn(F, Reporter) -> Finished<F> + Send + Sync>,
    pub faults: Vec<String>,
}
impl<P: Send + 'static, R: Send + 'static, F: Send + 'static> Pipeline<P, R, F> {
    pub fn new(capacity: usize, preparations: usize, finalizations: usize,
        prepare: impl Fn(P, Arc<AtomicBool>) -> Prepared<R, F> + Send + Sync + 'static,
        finalize: impl Fn(F, Reporter) -> Finished<F> + Send + Sync + 'static) -> Self {
        assert!(capacity > 0 && preparations > 0 && finalizations > 0);
        Self { entries: BTreeMap::new(), capacity, preparations, finalizations, mode: Mode::Open,
            prepare: Arc::new(prepare), finalize: Arc::new(finalize), faults: vec![] }
    }
    pub fn counts(&self) -> Counts {
        let mut n = Counts::default();
        for e in self.entries.values() {
            n.charged += usize::from(e.charged);
            match &e.phase {
                Phase::Reserved(_) => n.reserved += 1,
                Phase::Preparing(_) => n.preparing += 1,
                Phase::Running(_) => n.running += 1,
                Phase::FinalizationQueued { .. } | Phase::Finalizing { .. } if e.charged => n.finalizing += 1,
                Phase::FinalizationQueued { .. } | Phase::Finalizing { .. } => n.delivering += 1,
                Phase::Held { .. } => n.held += 1,
            }
        }
        n
    }
    pub fn can_admit(&self) -> bool {
        self.mode == Mode::Open && self.counts().charged < self.capacity
            && self.entries.len() < self.capacity + self.finalizations
    }
    pub fn admit(&mut self, ticket: Ticket, value: P) -> Result<(), P> {
        if !self.can_admit() || self.entries.contains_key(&ticket) { return Err(value); }
        self.entries.insert(ticket.clone(), Entry { owner: Ownership::Reservation { ticket }, charged: true,
            cancel: Arc::new(AtomicBool::new(false)), phase: Phase::Reserved(value) });
        Ok(())
    }
    pub fn contains(&self, ticket: &Ticket) -> bool { self.entries.contains_key(ticket) }
    pub fn tickets(&self) -> Vec<Ticket> { self.entries.keys().cloned().collect() }
    pub fn restore_running(&mut self, owner: Ownership, value: R) -> Result<(), R> {
        let ticket = owner.ticket().clone();
        if self.entries.contains_key(&ticket) { return Err(value); }
        self.entries.insert(ticket, Entry { owner, charged: true, cancel: Arc::new(AtomicBool::new(false)), phase: Phase::Running(value) });
        Ok(())
    }
    /// A controller can hand off only independently owned running transports.
    /// Preparation, publication, held effects and queued results stay barriers.
    pub fn handoff_ready(&self, adoptable: impl Fn(&R) -> bool) -> bool {
        self.entries.values().all(|entry| matches!(&entry.phase, Phase::Running(value) if adoptable(value)))
    }
    pub fn restore_finalization(&mut self, owner: Ownership, value: F) -> Result<(), F> {
        let ticket = owner.ticket().clone();
        if self.entries.contains_key(&ticket) { return Err(value); }
        self.entries.insert(ticket, Entry { owner, charged: true, cancel: Arc::new(AtomicBool::new(self.mode != Mode::Open)),
            phase: Phase::FinalizationQueued { value, not_before: Instant::now() } });
        Ok(())
    }
    pub fn drain(&mut self) {
        self.mode = Mode::Stopping;
        for e in self.entries.values() { e.cancel.store(true, Ordering::SeqCst); }
    }
    pub fn natural_drain(&mut self) {
        if self.mode == Mode::Stopping { return; }
        self.mode = Mode::Draining;
        for e in self.entries.values() {
            if matches!(e.phase, Phase::Reserved(_) | Phase::Preparing(_)) { e.cancel.store(true, Ordering::SeqCst); }
        }
    }
    pub fn resume_admission(&mut self) { if self.mode == Mode::Draining { self.mode = Mode::Open; } }
    /// Idle includes all local jobs/effects, not merely zero agent subprocesses.
    pub fn is_idle(&self) -> bool { self.entries.is_empty() }
    pub fn visit_running(&mut self, mut visit: impl FnMut(&Ticket, &mut R, bool)) {
        for (ticket, entry) in &mut self.entries {
            if let Phase::Running(value) = &mut entry.phase { visit(ticket, value, self.mode == Mode::Stopping); }
        }
    }
    pub fn poll(&mut self, mut completed: impl FnMut(&mut R) -> Option<F>) {
        let now = Instant::now();
        let tickets: Vec<_> = self.entries.keys().cloned().collect();
        for ticket in tickets {
            let mut e = self.entries.remove(&ticket).unwrap();
            let mut keep = true;
            e.phase = match e.phase {
                Phase::Preparing(mut job) => match job.poll() {
                    Some(Ok(Prepared::Running { owner, value })) if owner.ticket() == &ticket => { e.owner = owner; Phase::Running(value) },
                    Some(Ok(Prepared::Finalize { owner, value })) if owner.ticket() == &ticket => { e.owner = owner; Phase::FinalizationQueued { value, not_before: now } },
                    Some(Ok(_)) => Phase::Held { value: None, reason: "preparation returned a different task/session; ownership retained".into() },
                    Some(Err(reason)) => Phase::Held { value: None, reason },
                    None => Phase::Preparing(job),
                },
                Phase::Running(mut value) => match completed(&mut value) {
                    Some(value) => Phase::FinalizationQueued { value, not_before: now },
                    None => Phase::Running(value),
                },
                Phase::Finalizing { mut job, events } => {
                    while let Ok(FinalEvent::Released(owner)) = events.try_recv() {
                        if owner == e.owner { e.charged = false; }
                        else { self.faults.push(format!("{}: stale/foreign release ignored", ticket.task_id)); }
                    }
                    match job.poll() {
                        Some(Ok(Finished::Complete)) => {
                            // The completion and release channels may become
                            // readable together; drain again before deciding.
                            while let Ok(FinalEvent::Released(owner)) = events.try_recv() {
                                if owner == e.owner { e.charged = false; }
                            }
                            if !e.charged { keep = false; }
                            Phase::Held { value: None, reason: "finalizer completed without a matching hub release; ownership retained".into() }
                        },
                        Some(Ok(Finished::Retry { value, after })) => Phase::FinalizationQueued { value, not_before: now + after },
                        Some(Ok(Finished::Held { value, reason })) => Phase::Held { value: Some(value), reason },
                        Some(Err(reason)) => Phase::Held { value: None, reason },
                        None => Phase::Finalizing { job, events },
                    }
                },
                other => other,
            };
            if keep { self.entries.insert(ticket, e); }
        }
        // Start bounded jobs only after harvesting ALL available events. A slow
        // earlier job cannot hide later completions or block admission/refill.
        let mut preparing = self.counts().preparing;
        let mut finalizing = self.entries.values().filter(|e| matches!(e.phase, Phase::Finalizing { .. })).count();
        let tickets: Vec<_> = self.entries.keys().cloned().collect();
        for ticket in tickets {
            let same_task_busy = self.entries.iter().any(|(other, e)| other != &ticket && other.task_id == ticket.task_id && !matches!(e.phase, Phase::Reserved(_)));
            let resource_busy = self.entries.iter().any(|(other, e)| other != &ticket && other.task_id == ticket.task_id
                && matches!(e.phase, Phase::Preparing(_) | Phase::Running(_) | Phase::Finalizing { .. } | Phase::Held { .. }));
            let e = self.entries.get_mut(&ticket).unwrap();
            let old = std::mem::replace(&mut e.phase, Phase::Held { value: None, reason: "phase transition in progress".into() });
            e.phase = match old {
                Phase::Reserved(value) if preparing < self.preparations && !same_task_busy => {
                    let work = self.prepare.clone(); let cancel = e.cancel.clone(); preparing += 1;
                    Phase::Preparing(Job::start(move || work(value, cancel)))
                },
                Phase::FinalizationQueued { value, not_before } if finalizing < self.finalizations && not_before <= now && !resource_busy => {
                    let work = self.finalize.clone(); let (tx, events) = mpsc::channel(); finalizing += 1;
                    Phase::Finalizing { job: Job::start(move || work(value, Reporter(tx))), events }
                },
                other => other,
            };
        }
    }
    pub fn held(&self) -> Vec<(&Ticket, &str)> {
        self.entries.iter().filter_map(|(ticket, e)| match &e.phase {
            Phase::Held { value, reason } => { let _ = value; Some((ticket, reason.as_str())) }, _ => None,
        }).collect()
    }
}
