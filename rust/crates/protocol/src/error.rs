//! Error type for the protocol crate.

use thiserror::Error;

/// Errors produced by protocol types and helpers.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProtocolError {
    /// An integer calculation did not fit in its target type. Overflow is an error, never a wrap.
    #[error("arithmetic overflow computing {0}")]
    Overflow(&'static str),

    /// An order identifier is not 1 to 64 characters of `[A-Za-z0-9_-]`.
    #[error("invalid order id {0:?}: expected 1 to 64 characters of A-Z, a-z, 0-9, '_' or '-'")]
    InvalidOrderId(String),

    /// An account identifier is not 1 to 64 characters of `[A-Za-z0-9_]` (Req 1.10).
    #[error("invalid account id {0:?}: expected 1 to 64 characters of A-Z, a-z, 0-9, or '_'")]
    InvalidAccountId(String),

    /// An instrument's decimals do not fit in `MONEY_DECIMALS`.
    #[error("instrument {0} has price_decimals + qty_decimals greater than MONEY_DECIMALS")]
    InvalidInstrument(&'static str),

    /// A message could not be serialized to JSON.
    #[error("failed to encode message as JSON: {0}")]
    Encode(String),
}
