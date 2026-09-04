# Test fixtures

`cert.pem` / `key.pem` are a **throwaway self-signed certificate for
`localhost`**, used only by the HTTP/2 tests in `test/api.test.js` to stand up a
TLS server on an ephemeral port.

They are not a secret and must never be used for anything else. hey itself sets
`InsecureSkipVerify` on every request (`requester.go:241`), so certificate
validity is irrelevant to the behaviour under test.

Regenerate with:

    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout key.pem -out cert.pem -days 36500 \
      -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
