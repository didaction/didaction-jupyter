mod artifacts;
mod config;
mod jupyter;
mod server;
pub use server::serve;

use notebook_protocol::{ErrorCode, ProtocolError};
type Result<T> = std::result::Result<T, ProtocolError>;
fn error(code: ErrorCode, message: &str) -> ProtocolError {
    let retryable = matches!(
        code,
        ErrorCode::Disconnected
            | ErrorCode::Timeout
            | ErrorCode::StaleRevision
            | ErrorCode::TransportError
    );
    ProtocolError {
        code,
        message: message.into(),
        retryable,
    }
}
fn malformed() -> ProtocolError {
    error(ErrorCode::MalformedResponse, "Invalid Jupyter response")
}
fn disconnected() -> ProtocolError {
    error(
        ErrorCode::Disconnected,
        "Jupyter connection failed; refresh before retrying",
    )
}
