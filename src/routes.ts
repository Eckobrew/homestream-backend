import * as music from './services/music/handler';
import * as requested from './services/requested/handler';
import * as integrations from './services/integrations/handler';
import * as youtube from './services/youtube/handler';
import * as service0 from './services/auth/handler';
import * as service1 from './services/categories/[type]/handler';
import * as service2 from './services/config/handler';
import * as service3 from './services/downloads/handler';
import * as service4 from './services/home/handler';
import * as service5 from './services/library/[type]/handler';
import * as service6 from './services/media/[id]/handler';
import * as service7 from './services/media/[id]/recommendations/handler';
import * as service8 from './services/mobile/v1/[...path]/handler';
import * as service9 from './services/playback/handler';
import * as service10 from './services/playback/progress/handler';
import * as service11 from './services/preview-stream/handler';
import * as service12 from './services/profiles/handler';
import * as service13 from './services/request/handler';
import * as service14 from './services/search/handler';
import * as service15 from './services/stream/download/handler';
import * as serviceTorrent from './services/stream/torrent/handler';
import * as service16 from './services/subtitles/handler';
import * as service17 from './services/trailer/handler';
import * as service18 from './services/webhook/arr/handler';
export const routes = [
  {path:'/api/music',methods:['GET'],service:music},
  {path:'/api/music/album',methods:['GET','DELETE'],service:music},
  {path:'/api/music/artwork',methods:['GET'],service:music},
  {path:'/api/v1/music/artwork',methods:['GET'],service:music},
  {path:'/api/music/stream',methods:['GET'],service:music},
  {path:'/api/music/request',methods:['POST'],service:music},
  {path:'/api/music/profile-album',methods:['POST','DELETE'],service:music},
  {path:'/api/requested',methods:['GET'],service:requested},
  {path:'/api/integrations',methods:['GET','POST'],service:integrations},
  {path:'/api/youtube/search',methods:['GET'],service:youtube},
  {path:'/api/youtube/stream',methods:['GET'],service:youtube},
  {path:'/api/youtube/stream-video',methods:['GET','HEAD'],service:youtube},
  {path:'/api/youtube/progress',methods:['POST'],service:youtube},
  {path:'/api/youtube/continue-watching',methods:['GET','DELETE'],service:youtube},
  {path:'/api/youtube/auth',methods:['GET','POST','DELETE'],service:youtube},
  {path:'/api/youtube/recommendations',methods:['GET'],service:youtube},
  {path:'/api/youtube/download',methods:['POST'],service:youtube},
  {path:'/api/youtube/subscriptions',methods:['GET','POST','PUT','DELETE'],service:youtube},
  {path:'/api/youtube/subscriptions/check',methods:['POST'],service:youtube},
  {path:'/api/youtube/queue',methods:['GET','DELETE'],service:youtube},
  {path:'/api/youtube/archive',methods:['GET'],service:youtube},
  {path:'/api/youtube/stream-local',methods:['GET'],service:youtube},
  {path:'/api/youtube/thumbnail',methods:['GET'],service:youtube},
  { path: "/api/auth", methods: ["GET", "POST"], service: service0 },
  { path: "/api/categories/:type", methods: ["GET"], service: service1 },
  { path: "/api/config", methods: ["GET", "POST"], service: service2 },
  { path: "/api/downloads", methods: ["GET"], service: service3 },
  { path: "/api/home", methods: ["GET"], service: service4 },
  { path: "/api/library/:type", methods: ["GET"], service: service5 },
  { path: "/api/media/:id", methods: ["GET"], service: service6 },
  { path: "/api/media/:id/recommendations", methods: ["GET"], service: service7 },
  { path: "/api/mobile/v1/*", methods: ["GET", "POST", "HEAD", "OPTIONS"], service: service8 },
  { path: "/api/playback", methods: ["GET"], service: service9 },
  { path: "/api/playback/progress", methods: ["POST"], service: service10 },
  { path: "/api/preview-stream", methods: ["GET"], service: service11 },
  { path: "/api/profiles", methods: ["GET", "POST"], service: service12 },
  { path: "/api/request", methods: ["GET", "POST"], service: service13 },
  { path: "/api/search", methods: ["GET"], service: service14 },
  { path: "/api/stream/download", methods: ["GET"], service: service15 },
  { path: "/api/stream/torrent", methods: ["GET"], service: serviceTorrent },
  { path: "/api/subtitles", methods: ["GET"], service: service16 },
  { path: "/api/trailer", methods: ["GET"], service: service17 },
  { path: "/api/webhook/arr", methods: ["POST", "GET"], service: service18 },
];
