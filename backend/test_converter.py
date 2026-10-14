import io
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZIP_STORED, ZipFile

from converter import (
    MAX_FILE_BYTES,
    ConversionError,
    convert_book,
    input_format,
    validate_input,
    validate_output,
)
from server import safe_download_name


def make_epub():
    buffer = io.BytesIO()
    with ZipFile(buffer, "w", ZIP_STORED) as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0"?><container version="1.0"><rootfiles>'
            '<rootfile full-path="book.opf" media-type="application/oebps-package+xml"/>'
            "</rootfiles></container>",
        )
        archive.writestr(
            "book.opf",
            '<package xmlns="http://www.idpf.org/2007/opf" version="2.0">'
            '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
            "<dc:title>Test</dc:title><dc:language>en</dc:language>"
            "</metadata><manifest><item id=\"chapter\" href=\"chapter.xhtml\" "
            'media-type="application/xhtml+xml"/></manifest><spine>'
            '<itemref idref="chapter"/></spine></package>',
        )
        archive.writestr("chapter.xhtml", "<html><body><p>Test book</p></body></html>")
    return buffer.getvalue()


class ConverterValidationTests(unittest.TestCase):
    def test_accepts_only_supported_source_formats(self):
        self.assertEqual(input_format("book.EPUB"), "epub")
        self.assertEqual(input_format("book.mobi"), "mobi")
        self.assertEqual(input_format("book.azw3"), "azw3")
        with self.assertRaises(ConversionError):
            input_format("book.pdf")

    def test_rejects_empty_oversized_and_mismatched_uploads(self):
        with self.assertRaises(ConversionError):
            validate_input(b"", "epub")
        valid_epub = make_epub()
        validate_input(valid_epub, "epub")
        with self.assertRaises(ConversionError):
            validate_input(valid_epub + b"x" * MAX_FILE_BYTES, "epub")
        with self.assertRaises(ConversionError):
            validate_input(b"PK\x03\x04invalid archive", "epub")

    def test_rejects_epub_archives_with_excessive_declared_expansion(self):
        archive = bytearray(make_epub())
        central_directory = archive.index(b"PK\x01\x02")
        struct.pack_into("<I", archive, central_directory + 24, 128 * 1024 * 1024 + 1)
        with self.assertRaisesRegex(ConversionError, "128 MiB"):
            validate_input(bytes(archive), "epub")

    def test_checks_palm_book_signature_for_mobi_and_azw3(self):
        book = bytearray(68)
        book[60:68] = b"BOOKMOBI"
        validate_input(bytes(book), "mobi")
        validate_input(bytes(book), "azw3")
        with self.assertRaises(ConversionError):
            validate_input(bytes(68), "mobi")

    def test_checks_output_signatures(self):
        validate_output(make_epub(), "epub")
        book = bytearray(68)
        book[60:68] = b"BOOKMOBI"
        validate_output(bytes(book), "mobi")
        with self.assertRaises(ConversionError):
            validate_output(b"bad", "azw3")
        with self.assertRaises(ConversionError):
            validate_output(b"PK\x03\x04book", "mobi")

    def test_download_filename_drops_paths_and_unsafe_characters(self):
        self.assertEqual(
            safe_download_name(r"..\private\My book.epub", "azw3"),
            "My book.azw3",
        )
        self.assertEqual(safe_download_name("../../../.epub", "mobi"), "converted-book.mobi")

    def test_converter_runs_with_fixed_executable_arguments_without_a_shell(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.epub"
            output = Path(directory) / "output.mobi"
            output.write_bytes(b"PK\x03\x04not mobi")
            with patch("converter.shutil.which", return_value="/usr/bin/ebook-convert"):
                with patch("converter.subprocess.run") as run:
                    with self.assertRaises(ConversionError):
                        convert_book(source, "mobi", output)
            self.assertEqual(run.call_args.args[0], ["/usr/bin/ebook-convert", str(source), str(output)])
            self.assertNotIn("shell", run.call_args.kwargs)
            self.assertEqual(run.call_args.kwargs["stdin"], -3)
            self.assertEqual(run.call_args.kwargs["timeout"], 180)


if __name__ == "__main__":
    unittest.main()
