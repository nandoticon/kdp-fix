import json
import os
import re
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

from converter import (
    MAX_FILE_BYTES,
    SUPPORTED_FORMATS,
    ConversionError,
    converter_ready,
    convert_book,
    input_format,
    validate_input,
)

SITE_ROOT = Path(__file__).resolve().parent / "site"
MAX_ACTIVE_CONVERSIONS = threading.BoundedSemaphore(1)
SAFE_FILENAME_CHARS = re.compile(r"[^A-Za-z0-9._() \-\u00a0-\uffff]")


def safe_download_name(filename, target):
    filename = filename.replace("\\", "/").split("/")[-1]
    stem = Path(filename).stem
    if stem.startswith("."):
        stem = ""
    stem = SAFE_FILENAME_CHARS.sub("_", stem).strip(" .")[:120]
    if not stem or stem.startswith("."):
        stem = "converted-book"
    return f"{stem}.{target}"


class ConverterHandler(SimpleHTTPRequestHandler):
    server_version = "KdpFix"
    sys_version = ""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE_ROOT), **kwargs)

    def end_headers(self):
        if urlsplit(self.path).path.startswith("/api/converter/"):
            self.send_header("Cache-Control", "no-store, max-age=0")
            self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/converter/health":
            self.send_json(200, {"available": converter_ready()})
            return
        if path.startswith("/api/converter/"):
            self.send_json(404, {"error": "Not found"})
            return
        super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path != "/api/converter/convert":
            self.send_json(404, {"error": "Not found"})
            return

        if self.headers.get_content_type() != "application/octet-stream":
            self.send_json(415, {"error": "Send one ebook as application/octet-stream."})
            return

        content_length = self.headers.get("Content-Length")
        if not content_length or not content_length.isdigit():
            self.send_json(411, {"error": "A valid Content-Length header is required."})
            return
        if len(content_length) > 10 or int(content_length) > MAX_FILE_BYTES:
            self.send_json(413, {"error": "Files must be 4 MiB or smaller."})
            return

        try:
            query = parse_qs(urlsplit(self.path).query, max_num_fields=2)
        except ValueError:
            self.send_json(400, {"error": "The conversion request has too many parameters."})
            return
        target = query.get("target", [""])[0].lower()
        if target not in SUPPORTED_FORMATS:
            self.send_json(400, {"error": "Choose EPUB, MOBI, or AZW3 as the output format."})
            return
        encoded_filename = self.headers.get("X-Source-Filename", "book")
        if len(encoded_filename) > 512:
            self.send_json(400, {"error": "The source filename is too long."})
            return
        filename = unquote(encoded_filename)
        try:
            source_extension = input_format(filename)
            if source_extension == target:
                raise ConversionError("Choose a different output format.", 400)
        except ConversionError as error:
            self.send_json(error.status, {"error": str(error)})
            return

        if not MAX_ACTIVE_CONVERSIONS.acquire(blocking=False):
            self.send_json(429, {"error": "The converter is busy. Please try again shortly."})
            return

        try:
            data = self.rfile.read(int(content_length))
            if len(data) != int(content_length):
                raise ConversionError("The upload ended before the full file was received.", 400)
            validate_input(data, source_extension)
            with tempfile.TemporaryDirectory(prefix="kdp-convert-") as temporary_directory:
                working_directory = Path(temporary_directory)
                source = working_directory / f"input.{source_extension}"
                output = working_directory / f"output.{target}"
                source.write_bytes(data)
                converted = convert_book(source, target, output)
            self.send_converted_file(converted, safe_download_name(filename, target))
        except ConversionError as error:
            self.send_json(error.status, {"error": str(error)})
        except (OSError, ValueError):
            self.send_json(500, {"error": "The conversion could not be completed."})
        finally:
            MAX_ACTIVE_CONVERSIONS.release()

    def send_converted_file(self, data, filename):
        fallback = filename.encode("ascii", "ignore").decode("ascii")
        fallback = fallback.replace("\\", "_").replace('"', "_") or "converted-book"
        encoded_filename = quote(filename, safe="")
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header(
            "Content-Disposition",
            f'attachment; filename="{fallback}"; filename*=UTF-8\'\'{encoded_filename}',
        )
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, status, value):
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def list_directory(self, path):
        self.send_error(404)
        return None

    def log_message(self, format_string, *args):
        if urlsplit(self.path).path.startswith("/api/converter/"):
            return
        super().log_message(format_string, *args)


def main():
    port = int(os.environ.get("PORT", "80"))
    server = ThreadingHTTPServer(("0.0.0.0", port), ConverterHandler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
