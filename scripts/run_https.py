"""Run the app over HTTPS on your LAN so phones can use the camera.

    python scripts/run_https.py            # port 8443
    python scripts/run_https.py --port 9443

Creates a self-signed certificate in certs/ (valid for this PC's LAN IPs and localhost)
the first time, then starts uvicorn with it. Phones will show a security warning once:
tap "Advanced" -> "Proceed". For testing only; use a real certificate in production.
"""
import argparse
import datetime
import ipaddress
import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CERT_DIR = ROOT / "certs"
CERT, KEY = CERT_DIR / "cert.pem", CERT_DIR / "key.pem"


def lan_ips() -> list[str]:
    ips = {"127.0.0.1"}
    try:  # the address used to reach the internet/router is the LAN address
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ips)


def make_cert(ips: list[str]):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Remote Maintenance (local test)")])
    now = datetime.datetime.now(datetime.timezone.utc)
    san = [x509.DNSName("localhost")] + [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .sign(key, hashes.SHA256())
    )
    CERT_DIR.mkdir(exist_ok=True)
    KEY.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                      serialization.NoEncryption()))
    CERT.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--new-cert", action="store_true", help="regenerate (e.g. after your IP changed)")
    args = ap.parse_args()

    ips = lan_ips()
    if args.new_cert or not CERT.exists():
        make_cert(ips)
        print(f"Created certificate for: localhost, {', '.join(ips)}")

    print("\nOpen on this PC:   https://localhost:%d" % args.port)
    for ip in ips:
        if ip != "127.0.0.1":
            print("Open on the phone: https://%s:%d   (same Wi-Fi; accept the warning once)" % (ip, args.port))
    print()

    sys.path.insert(0, str(ROOT))
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=args.port,
                ssl_certfile=str(CERT), ssl_keyfile=str(KEY))


if __name__ == "__main__":
    main()
