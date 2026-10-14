import io
import os
import shutil
import subprocess
from pathlib import Path
from zipfile import BadZipFile, LargeZipFile, ZipFile

SUPPORTED_FORMATS = {"epub", "mobi", "azw3"}
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_EPUB_ENTRIES = 10_000
MAX_EPUB_UNCOMPRESSED_BYTES = 128 * 1024 * 1024
CONVERSION_TIMEOUT_SECONDS = 180


class ConversionError(Exception):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def input_format(filename):
    extension = Path(filename).suffix.lower().lstrip(".")
    if extension not in SUPPORTED_FORMATS:
        raise ConversionError("Only EPUB, MOBI, and AZW3 files are supported.", 415)
    return extension


def validate_input(data, extension):
    if not data:
        raise ConversionError("The uploaded file is empty.", 400)
    if len(data) > MAX_FILE_BYTES:
        raise ConversionError("Files must be 4 MiB or smaller.", 413)
    if extension == "epub":
        if not data.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
            raise ConversionError("The file contents do not look like an EPUB archive.")
        try:
            with ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
                if len(entries) > MAX_EPUB_ENTRIES:
                    raise ConversionError("The EPUB contains too many archive entries.")
                if sum(entry.file_size for entry in entries) > MAX_EPUB_UNCOMPRESSED_BYTES:
                    raise ConversionError("The EPUB expands beyond the 128 MiB conversion limit.")
        except (BadZipFile, LargeZipFile, OSError) as error:
            raise ConversionError("The EPUB archive is damaged or invalid.") from error
    elif len(data) < 68 or data[60:68] != b"BOOKMOBI":
        raise ConversionError("The file contents do not look like a MOBI/AZW3 book.")


def validate_output(data, target):
    if not data:
        raise ConversionError("The converter produced an empty file.", 500)
    if len(data) > MAX_FILE_BYTES:
        raise ConversionError("The converted file exceeds the 4 MiB download limit.", 413)
    if target == "epub":
        try:
            validate_input(data, "epub")
        except ConversionError as error:
            raise ConversionError("The converter output failed format validation.", 500) from error
        return
    else:
        valid = len(data) >= 68 and data[60:68] == b"BOOKMOBI"
    if not valid:
        raise ConversionError("The converter output failed format validation.", 500)


def converter_ready():
    executable = shutil.which("ebook-convert")
    if not executable:
        return False
    try:
        result = subprocess.run(
            [executable, "--version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def convert_book(source, target, output):
    executable = shutil.which("ebook-convert")
    if not executable:
        raise ConversionError("The conversion engine is not installed.", 503)
    temporary_directory = str(source.parent)
    environment = os.environ.copy()
    environment.update(
        {
            "HOME": temporary_directory,
            "TMPDIR": temporary_directory,
            "CALIBRE_CONFIG_DIRECTORY": str(source.parent / "calibre-config"),
            "CALIBRE_CACHE_DIRECTORY": str(source.parent / "calibre-cache"),
            "QT_QPA_PLATFORM": "offscreen",
        }
    )
    try:
        result = subprocess.run(
            [executable, str(source), str(output)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=environment,
            timeout=CONVERSION_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise ConversionError("Conversion took too long. Try a smaller or simpler book.", 504) from error
    except OSError as error:
        raise ConversionError("The conversion engine could not be started.", 503) from error
    if result.returncode != 0 or not output.is_file():
        raise ConversionError(
            "Conversion failed. The book may be DRM-protected, damaged, or unsupported."
        )
    data = output.read_bytes()
    validate_output(data, target)
    return data
