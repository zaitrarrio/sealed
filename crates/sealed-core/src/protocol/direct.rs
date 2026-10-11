//! Direct / Room claim-approve state machine (spec §6.1–6.2). Pure: emits commands, consumes events.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectState {
    Idle,
    Creating,
    Uploading { transfer_ready: bool },
    WaitingForClaim,
    ClaimPending,
    Approving,
    Approved,
    Downloading,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone)]
pub enum DirectEvent {
    StartShare { room: bool },
    TransferCreated { transfer_id: String },
    UploadProgress { done: u64, total: u64 },
    UploadFinished,
    ClaimReceived { claim_id: String, label: String, sas: String },
    Approve { claim_id: String },
    Approved { claim_id: String },
    Deny { claim_id: String },
    DownloadProgress { done: u64, total: u64 },
    DownloadFinished,
    Cancel,
    Error { message: String },
}

#[derive(Debug, Clone)]
pub enum DirectCommand {
    CreateTransfer { room: bool },
    UploadSegments,
    SubscribeEvents,
    PostApproval { claim_id: String },
    PostDeny { claim_id: String },
    DownloadSegments,
    CancelTransfer,
    ShowSafetyCode { sas: String, label: String },
    ShowError { message: String },
}

pub struct DirectMachine {
    pub state: DirectState,
    pub room: bool,
    pub transfer_id: Option<String>,
    pub pending_claim: Option<(String, String, String)>,
}

impl DirectMachine {
    pub fn new() -> Self {
        Self {
            state: DirectState::Idle,
            room: false,
            transfer_id: None,
            pending_claim: None,
        }
    }

    pub fn handle(&mut self, ev: DirectEvent) -> Vec<DirectCommand> {
        use DirectCommand as C;
        use DirectEvent as E;
        use DirectState as S;
        match (&self.state, ev) {
            (S::Idle, E::StartShare { room }) => {
                self.room = room;
                self.state = S::Creating;
                vec![C::CreateTransfer { room }]
            }
            (S::Creating, E::TransferCreated { transfer_id }) => {
                self.transfer_id = Some(transfer_id);
                self.state = S::Uploading { transfer_ready: false };
                vec![C::UploadSegments, C::SubscribeEvents]
            }
            (S::Uploading { .. }, E::UploadFinished) => {
                self.state = S::WaitingForClaim;
                vec![]
            }
            (S::Uploading { .. } | S::WaitingForClaim | S::ClaimPending, E::ClaimReceived { claim_id, label, sas }) => {
                self.pending_claim = Some((claim_id.clone(), label.clone(), sas.clone()));
                self.state = S::ClaimPending;
                vec![C::ShowSafetyCode { sas, label }]
            }
            (S::ClaimPending, E::Approve { claim_id }) => {
                self.state = S::Approving;
                vec![C::PostApproval { claim_id }]
            }
            (S::Approving, E::Approved { .. }) => {
                self.state = S::Approved;
                vec![]
            }
            (S::ClaimPending, E::Deny { claim_id }) => {
                self.state = S::WaitingForClaim;
                self.pending_claim = None;
                vec![C::PostDeny { claim_id }]
            }
            (_, E::Cancel) => {
                self.state = S::Cancelled;
                vec![C::CancelTransfer]
            }
            (_, E::Error { message }) => {
                self.state = S::Failed;
                vec![C::ShowError { message }]
            }
            // Receiver side
            (S::Idle, E::Approved { .. }) => {
                self.state = S::Downloading;
                vec![C::DownloadSegments]
            }
            (S::Downloading, E::DownloadFinished) => {
                self.state = S::Done;
                vec![]
            }
            _ => vec![],
        }
    }
}

impl Default for DirectMachine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sender_happy_path_to_safety_code() {
        let mut m = DirectMachine::new();
        let c = m.handle(DirectEvent::StartShare { room: false });
        assert!(matches!(c[0], DirectCommand::CreateTransfer { room: false }));
        let _ = m.handle(DirectEvent::TransferCreated {
            transfer_id: "t1".into(),
        });
        let c = m.handle(DirectEvent::ClaimReceived {
            claim_id: "c1".into(),
            label: "Pixel".into(),
            sas: "123456".into(),
        });
        assert!(matches!(c[0], DirectCommand::ShowSafetyCode { .. }));
        assert_eq!(m.state, DirectState::ClaimPending);
    }
}
