# ntfy for Engram

On the host: `/opt/ntfy` holds these two files, data in `/srv/ntfy` (owned 1601). Traefik routes
`ntfy.example.com` → `172.17.0.1:8350`. `upstream-base-url` lets the iOS app get instant pushes through
ntfy.sh's relay (it only sees a hash of the topic and a poll request, never the message).

- Engram publishes to topic `engram` as user `engram` (write-only) with a token kept in `/etc/engram/engram.env`.
- Your phone subscribes as user `jai` (read-only). Create it with `ssh -t host docker exec -it ntfy ntfy user add jai`
  then `docker exec ntfy ntfy access jai engram read-only`.
