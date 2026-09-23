Self-signed TLS for LAN https://host:8443.

Do not commit `cert.pem` or `key.pem`. Generate locally:

```bash
openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=keyhole"
```
