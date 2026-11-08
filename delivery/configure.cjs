'use strict';
const fs=require('node:fs');const crypto=require('node:crypto');const net=require('node:net');
const [planFile,release,receipt]=process.argv.slice(2);const plan=JSON.parse(fs.readFileSync(planFile,'utf8'));
const settings={...plan.settings};
if(plan.legacyTrustProxy&&!plan.upstreamProxies.length)throw Error('The old service trusts forwarding headers without explicit proxy addresses. Configure HOMESTREAM_TRUSTED_PROXIES in its environment before upgrading.');
for(const cidr of plan.upstreamProxies){const [ip,prefix]=cidr.split('/');const family=net.isIP(ip);if(!family||(prefix!==undefined&&(!/^\d+$/.test(prefix)||Number(prefix)>(family===4?32:128))))throw Error('An old trusted-proxy entry is not an IP address or CIDR.');}
let secret=settings.HOMESTREAM_SESSION_SECRET||settings.HOMESTREAM_MOBILE_TOKEN||'';
if(secret.length<32)secret=crypto.randomBytes(32).toString('hex');
Object.assign(settings,{HOMESTREAM_SESSION_SECRET:secret,HOMESTREAM_TRUSTED_PROXIES:'127.0.0.1,::1',HOMESTREAM_INTERNAL_URL:'http://127.0.0.1:3001',DATA_DIR:release+'/data'});
delete settings.HOMESTREAM_TRUST_PROXY;
settings.HOMESTREAM_EXTERNAL_URL ||= settings.NEXT_PUBLIC_APP_URL||'';
const quote=value=>{value=String(value);if(/[\r\n\0]/.test(value))throw Error('An environment value contains control characters; manual migration is required.');return '"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';};
fs.writeFileSync(receipt+'/backend.env',Object.entries(settings).map(([key,value])=>`${key}=${quote(value)}`).join('\n')+'\n',{mode:0o600});
const realip=plan.upstreamProxies.map(value=>`    set_real_ip_from ${value};`).join('\n');
fs.writeFileSync(receipt+'/nginx.conf',`map "$http_forwarded|$http_x_forwarded_for|$http_x_real_ip|$http_cf_connecting_ip" $hs111_forwarded {
    default 1;
    "|||" 0;
}
geo $realip_remote_addr $hs111_upstream_trusted {
    default 0;
${plan.upstreamProxies.map(value=>`    ${value} 1;`).join('\n')}
}
map "$hs111_forwarded:$hs111_upstream_trusted" $hs111_client {
    default $remote_addr;
    "1:0" "";
}
server {
    listen ${plan.loopbackOnly?'127.0.0.1:':''}${plan.port};
    listen [${plan.loopbackOnly?'::1':'::'}]:${plan.port};
    server_name _;
${realip}
${realip?'    real_ip_header X-Forwarded-For;\n    real_ip_recursive on;':''}
    client_max_body_size 1m;
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $hs111_client;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Forwarded "";
        proxy_set_header X-Real-IP "";
        proxy_set_header CF-Connecting-IP "";
        proxy_set_header X-HomeStream-Socket "";
        proxy_set_header X-HomeStream-Proof "";
        proxy_set_header X-HomeStream-Local-Pairing "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 180s;
    }
    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $hs111_client;
    }
}
`,{mode:0o600});

fs.writeFileSync(receipt+'/web.env',`APP_NAME=${quote(plan.appName)}\nHOMESTREAM_BACKEND_URL=\"http://127.0.0.1:3001\"\n`,{mode:0o600});
