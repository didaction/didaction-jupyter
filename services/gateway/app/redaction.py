import logging
import re

REDACTED = "[REDACTED]"
SENSITIVE = re.compile(
    r"(?i)(token|notebook-client|authorization|cookie|session-id|kernel-id|code|source|output|content)"
)


def redact(value: object) -> object:
    if isinstance(value, dict):
        return {
            key: (REDACTED if SENSITIVE.search(str(key)) else redact(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, dict):
            record.args = {
                key: (REDACTED if SENSITIVE.search(str(key)) else redact(item))
                for key, item in record.args.items()
            }
        return True
