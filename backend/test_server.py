import io
import http.client
import json
import threading
import unittest
from urllib.parse import urlencode
from unittest.mock import patch
from zipfile import ZIP_STORED, ZipFile

from server import ConverterHandler, ThreadingHTTPServer


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


class ConverterServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), ConverterHandler)
        cls.httpd.daemon_threads = True
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, response.getheaders(), response.read()
        connection.close()
        return result

    def test_health_reports_converter_runtime_readiness(self):
        with patch("server.converter_ready", return_value=True):
            status, headers, body = self.request("GET", "/api/converter/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"available": True})
        self.assertIn(("Cache-Control", "no-store, max-age=0"), headers)

    def test_conversion_returns_validated_download_and_disposes_temp_input(self):
        output = bytearray(68)
        output[60:68] = b"BOOKMOBI"
        source = make_epub()
        query = urlencode({"target": "mobi"})

        def fake_convert(source_path, target, output_path):
            self.assertEqual(source_path.read_bytes(), source)
            self.assertEqual(target, "mobi")
            output_path.write_bytes(output)
            return bytes(output)

        with patch("server.convert_book", side_effect=fake_convert):
            status, headers, body = self.request(
                "POST",
                f"/api/converter/convert?{query}",
                body=source,
                headers={
                    "Content-Type": "application/octet-stream",
                    "Content-Length": str(len(source)),
                    "X-Source-Filename": "../../My%20book.epub",
                },
            )

        self.assertEqual(status, 200)
        self.assertEqual(body, bytes(output))
        self.assertEqual(dict(headers)["Content-Type"], "application/octet-stream")
        self.assertIn('filename="My book.mobi"', dict(headers)["Content-Disposition"])
        self.assertEqual(dict(headers)["Cache-Control"], "no-store, max-age=0")

    def test_rejects_wrong_content_type_and_unsupported_routes(self):
        status, _, body = self.request(
            "POST",
            "/api/converter/convert?target=mobi",
            body=b"book",
            headers={"Content-Type": "text/plain", "Content-Length": "4"},
        )
        self.assertEqual(status, 415)
        self.assertEqual(json.loads(body)["error"], "Send one ebook as application/octet-stream.")

        status, _, _ = self.request("GET", "/api/converter/unknown")
        self.assertEqual(status, 404)

    def test_rejects_invalid_book_content_before_launching_converter(self):
        query = urlencode({"target": "mobi"})
        with patch("server.convert_book") as convert:
            status, _, body = self.request(
                "POST",
                f"/api/converter/convert?{query}",
                body=b"not an epub",
                headers={
                    "Content-Type": "application/octet-stream",
                    "Content-Length": "11",
                    "X-Source-Filename": "book.epub",
                },
            )
        self.assertEqual(status, 422)
        self.assertFalse(convert.called)
        self.assertIn("EPUB archive", json.loads(body)["error"])


if __name__ == "__main__":
    unittest.main()
