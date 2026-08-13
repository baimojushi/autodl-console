#!/usr/bin/env python3
import argparse, base64, hashlib, json, os, select, socket, ssl, struct, sys, time
from urllib.parse import urlparse

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

def log(message):
    print(time.strftime("%Y-%m-%dT%H:%M:%S%z"), message, flush=True)

def read_exact(sock, length):
    data = bytearray()
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            raise ConnectionError("WebSocket connection closed")
        data.extend(chunk)
    return bytes(data)

def read_headers(sock):
    data = bytearray()
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("Connection closed during WebSocket handshake")
        data.extend(chunk)
        if len(data) > 65536:
            raise ConnectionError("WebSocket handshake headers too large")
    header_bytes, _ = bytes(data).split(b"\r\n\r\n", 1)
    lines = header_bytes.decode("iso-8859-1").split("\r\n")
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            name, value = line.split(":", 1)
            headers[name.strip().lower()] = value.strip()
    return lines[0], headers

def connect_websocket(url):
    parsed = urlparse(url)
    if parsed.scheme not in ("ws", "wss") or not parsed.hostname:
        raise ValueError("invalid WebSocket URL")
    secure = parsed.scheme == "wss"
    port = parsed.port or (443 if secure else 80)
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query

    raw = socket.create_connection((parsed.hostname, port), timeout=15)
    if secure:
        raw = ssl.create_default_context().wrap_socket(raw, server_hostname=parsed.hostname)

    key = base64.b64encode(os.urandom(16)).decode("ascii")
    host = parsed.hostname
    if (secure and port != 443) or (not secure and port != 80):
        host = f"{host}:{port}"
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "User-Agent: autodl-boot-guard/1.1\r\n\r\n"
    )
    raw.sendall(request.encode("ascii"))
    status, headers = read_headers(raw)
    if " 101 " not in status:
        raw.close()
        raise ConnectionError(f"WebSocket upgrade rejected: {status}")
    expected = base64.b64encode(
        hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
    ).decode("ascii")
    if headers.get("sec-websocket-accept") != expected:
        raw.close()
        raise ConnectionError("Invalid Sec-WebSocket-Accept")
    raw.settimeout(None)
    return raw

def masked_frame(opcode, payload=b""):
    if isinstance(payload, str):
        payload = payload.encode()
    first = 0x80 | opcode
    length = len(payload)
    mask = os.urandom(4)
    if length < 126:
        header = struct.pack("!BB", first, 0x80 | length)
    elif length <= 0xFFFF:
        header = struct.pack("!BBH", first, 0x80 | 126, length)
    else:
        header = struct.pack("!BBQ", first, 0x80 | 127, length)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return header + mask + masked

def send_json(sock, value):
    sock.sendall(masked_frame(0x1, json.dumps(value, separators=(",", ":"))))

def send_pong(sock, payload):
    sock.sendall(masked_frame(0xA, payload))

def read_frame(sock):
    first, second = read_exact(sock, 2)
    if not (first & 0x80):
        raise ConnectionError("fragmented frame unsupported")
    opcode = first & 0x0F
    if second & 0x80:
        raise ConnectionError("server frame must not be masked")
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", read_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", read_exact(sock, 8))[0]
    if length > 65536:
        raise ConnectionError("frame too large")
    return opcode, read_exact(sock, length) if length else b""

def probe_tcp(port):
    started = time.monotonic()
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.6):
            return {"listening": True, "latencyMs": round((time.monotonic()-started)*1000, 1)}
    except OSError as exc:
        return {
            "listening": False,
            "latencyMs": round((time.monotonic()-started)*1000, 1),
            "error": exc.__class__.__name__,
        }

def heartbeat():
    return {
        "type": "heartbeat",
        "checkedAt": int(time.time() * 1000),
        "services": {"6006": probe_tcp(6006), "6008": probe_tcp(6008)},
    }

def run_once(url, token_holder, instance):
    sock = connect_websocket(url)
    try:
        send_json(sock, {"type": "boot-attest", "instance": instance, "token": token_holder[0]})
        sock.settimeout(20)
        opcode, payload = read_frame(sock)
        if opcode != 0x1:
            raise ConnectionError("attestation response missing")
        response = json.loads(payload.decode())
        if not response.get("ok"):
            raise ConnectionError("Boot attestation rejected")
        session_token = response.get("sessionToken")
        if isinstance(session_token, str) and session_token:
            token_holder[0] = session_token
        interval = max(5.0, min(30.0, float(response.get("heartbeatMs", 10000)) / 1000.0))
        sock.settimeout(None)
        log("boot attestation accepted")
        send_json(sock, heartbeat())
        while True:
            readable, _, _ = select.select([sock], [], [], interval)
            if readable:
                opcode, payload = read_frame(sock)
                if opcode == 0x8:
                    raise ConnectionError("server closed WebSocket")
                if opcode == 0x9:
                    send_pong(sock, payload)
                continue
            send_json(sock, heartbeat())
    finally:
        try: sock.close()
        except Exception: pass

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", required=True)
    p.add_argument("--token", required=True)
    p.add_argument("--instance", required=True)
    args = p.parse_args()
    token_holder = [args.token]
    delay = 3
    while True:
        try:
            run_once(args.url, token_holder, args.instance)
            delay = 3
        except KeyboardInterrupt:
            return 0
        except Exception as exc:
            log(f"connection error: {exc}; retrying in {delay}s")
            time.sleep(delay)
            delay = min(20, delay + 2)

if __name__ == "__main__":
    sys.exit(main())
