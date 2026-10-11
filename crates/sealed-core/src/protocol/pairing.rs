//! Pairing state machine including one-sided (relay-mediated) ceremony (spec §6.3.3).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingState {
    Idle,
    ShowingCode,
    ScannedPeer,
    WaitingReturn,
    ConfirmingSas,
    Paired,
    Failed,
}

#[derive(Debug, Clone)]
pub enum PairingEvent {
    /// Mutual: show our code for the other person to scan.
    StartMutual,
    /// One-sided: we scan their code; relay delivers our return bundle.
    StartOneSided,
    PeerCodeScanned { fingerprint: String, sas: String },
    ReturnBundleReceived { sas: String },
    ConfirmSas,
    RejectSas,
    Error { message: String },
}

#[derive(Debug, Clone)]
pub enum PairingCommand {
    DisplayPairingCode,
    SubmitReturnBundle { peer_fp: String },
    SubscribeReturnPath { peer_fp: String },
    ShowSafetyCode { sas: String },
    PersistContact { fingerprint: String },
    ShowError { message: String },
}

pub struct PairingMachine {
    pub state: PairingState,
    pub one_sided: bool,
    pub peer_fp: Option<String>,
    pub sas: Option<String>,
}

impl PairingMachine {
    pub fn new() -> Self {
        Self {
            state: PairingState::Idle,
            one_sided: false,
            peer_fp: None,
            sas: None,
        }
    }

    pub fn handle(&mut self, ev: PairingEvent) -> Vec<PairingCommand> {
        use PairingCommand as C;
        use PairingEvent as E;
        use PairingState as S;
        match (&self.state, ev) {
            (S::Idle, E::StartMutual) => {
                self.one_sided = false;
                self.state = S::ShowingCode;
                vec![C::DisplayPairingCode]
            }
            (S::Idle, E::StartOneSided) => {
                self.one_sided = true;
                self.state = S::Idle;
                vec![]
            }
            (S::Idle | S::ShowingCode, E::PeerCodeScanned { fingerprint, sas }) => {
                self.peer_fp = Some(fingerprint.clone());
                self.sas = Some(sas.clone());
                if self.one_sided {
                    self.state = S::WaitingReturn;
                    vec![
                        C::SubmitReturnBundle {
                            peer_fp: fingerprint.clone(),
                        },
                        C::SubscribeReturnPath { peer_fp: fingerprint },
                        C::ShowSafetyCode { sas },
                    ]
                } else {
                    self.state = S::ConfirmingSas;
                    vec![C::ShowSafetyCode { sas }]
                }
            }
            (S::WaitingReturn, E::ReturnBundleReceived { sas }) => {
                self.sas = Some(sas.clone());
                self.state = S::ConfirmingSas;
                vec![C::ShowSafetyCode { sas }]
            }
            (S::ConfirmingSas, E::ConfirmSas) => {
                self.state = S::Paired;
                vec![C::PersistContact {
                    fingerprint: self.peer_fp.clone().unwrap_or_default(),
                }]
            }
            (S::ConfirmingSas, E::RejectSas) => {
                self.state = S::Failed;
                vec![C::ShowError {
                    message: "Safety codes did not match. Pairing cancelled.".into(),
                }]
            }
            (_, E::Error { message }) => {
                self.state = S::Failed;
                vec![C::ShowError { message }]
            }
            _ => vec![],
        }
    }
}

impl Default for PairingMachine {
    fn default() -> Self {
        Self::new()
    }
}
