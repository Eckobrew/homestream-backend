FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go macos-negotiate.patch ./
RUN apk add --no-cache patch  && cp -R "$(go list -m -f '{{.Dir}}' github.com/sonroyaalmerol/go-smb-server)" /src/smb-server  && chmod -R u+w /src/smb-server  && patch -d /src/smb-server -p1 < macos-negotiate.patch  && go mod edit -replace github.com/sonroyaalmerol/go-smb-server=/src/smb-server
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /music-smb .
FROM scratch
COPY --from=build /music-smb /music-smb
USER 1001:1001
ENTRYPOINT ["/music-smb"]
