import {test} from 'node:test';
import assert from 'node:assert/strict';
import {videoQueue} from '../src/lib/requested-media';
import type {MediaItem} from '../src/types';
import type {QBittorrentRawTorrent} from '../src/lib/qbittorrent';
const media=(id:string,title:string,year=2025):MediaItem=>({id,title,year,type:'Series',status:'requested',source:'seerr',overview:'',genres:[],posterUrl:'',backdropUrl:''});
const download=(hash:string,name:string,progress:number,size:number):QBittorrentRawTorrent=>({hash,name,progress,total_size:size,downloaded:progress*size,dlspeed:1000,eta:120,state:'downloading',seq_dl:false,f_l_piece_prio:false,category:'sonarr',tags:'',content_path:''});
test('Requested aggregates episodes by size and never guesses ambiguous title matches',()=>{
 const rows=videoQueue([media('1','Example Show')],[download('a','Example.Show.S01E01',.5,100),download('b','Example.Show.S01E02',0,300)]);
 assert.equal(rows.length,1);assert.equal(rows[0].progress,12.5);assert.equal(rows[0].downloadSpeed,2000);
 const ambiguous=videoQueue([media('a','Example Show',2020),media('b','Example Show',2025)],[download('x','Example.Show.S01E01',.5,100)]);
 assert.equal(ambiguous.length,3);assert.equal(ambiguous[0].progress,undefined);assert.equal(ambiguous[1].progress,undefined);
 const distinct=videoQueue([media('1','Example')],[download('x','Examples.S01E01',.5,100)]);assert.equal(distinct.length,2);
 assert.equal(videoQueue([media('1','Example')],[])[0].progress,undefined);
});
