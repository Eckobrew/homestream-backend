import fs from 'node:fs';
import path from 'node:path';
// Generate Android-compatible Kotlin/OkHttp bindings directly from the shared schema.
type Schema = { $ref?:string; type?:string; properties?:Record<string,Schema>; required?:string[]; items?:Schema; anyOf?:Schema[]; allOf?:Schema[]; enum?:unknown[] };
type Operation = {operationId:string;parameters?:{name:string;in:string;required?:boolean;schema:Schema}[];requestBody?:{content:Record<string,{schema:Schema}>};responses:Record<string,{content?:Record<string,{schema:Schema}>}>};
const spec=JSON.parse(fs.readFileSync('contract/openapi.json','utf8')) as {info:{version:string};components:{schemas:Record<string,Schema>};paths:Record<string,Record<string,Operation>>};
const output='contract/kotlin/src/main/kotlin/uk/eckonet/homestream/api';
fs.rmSync('contract/kotlin/src',{recursive:true,force:true});fs.mkdirSync(output,{recursive:true});
const classes=new Map<string,string>();
const safe=(name:string)=>'`'+name+'`';
const className=(name:string)=>name.replace(/[^a-zA-Z0-9]+/g,'_').split('_').filter(Boolean).map(word=>word[0].toUpperCase()+word.slice(1)).join('');
function type(schema:Schema,name:string):string {
  if(schema.$ref)return className(schema.$ref.split('/').at(-1)!);
  if(schema.anyOf){const nonnull=schema.anyOf.filter(s=>s.type!=='null');if(nonnull.length===1)return type(nonnull[0],name)+'?';return 'JsonElement';}
  if(schema.allOf?.length===1)return type(schema.allOf[0],name);
  if(schema.type==='array')return `List<${type(schema.items||{},name+'Item')}>`;
  if(schema.type==='integer')return 'Long';
  if(schema.type==='number')return 'Double';
  if(schema.type==='boolean')return 'Boolean';
  if(schema.type==='string')return 'String';
  if(schema.properties&&Object.keys(schema.properties).length){
    const named=className(name);
    if(!classes.has(named)){
      classes.set(named,'');
      const fields=Object.entries(schema.properties).map(([key,value])=>{
        const fieldType=type(value,named+className(key));
        const optional=!schema.required?.includes(key);
        return `    @SerialName(${JSON.stringify(key)}) val ${safe(key)}: ${fieldType}${optional&&!fieldType.endsWith('?')?'?':''}${optional?' = null':''}`;
      });
      classes.set(named,`@Serializable\ndata class ${named}(\n${fields.join(',\n')}\n)`);
    }
    return named;
  }
  return 'JsonElement';
}
for(const [name,schema]of Object.entries(spec.components.schemas)){
 const mapped=type(schema,name);
 if(mapped!==className(name)&&!classes.has(className(name)))classes.set(className(name),`typealias ${className(name)} = ${mapped}`);
}
const methods:string[]=[];
for(const [url,operations]of Object.entries(spec.paths))for(const [method,op]of Object.entries(operations)){
 const name=className(op.operationId);
 const params=op.parameters||[];
 const argumentsList=params.filter(p=>p.in==='path').map(p=>`${safe(p.name)}: String`);
 const queryParams=params.filter(p=>p.in==='query');
 const queryName=type({type:'object',properties:Object.fromEntries(queryParams.map(p=>[p.name,p.schema])),required:queryParams.filter(p=>p.required).map(p=>p.name)},name+'Query');
 if(queryParams.length)argumentsList.push(`query: ${queryName}`);
 const bodySchema=op.requestBody?.content['application/json']?.schema;
 let bodyName:string|undefined;
 if(bodySchema){bodyName=type(bodySchema,name+'Body');argumentsList.push(`body: ${bodyName}`);}
 if(params.some(p=>p.in==='header'&&p.name==='Range'))argumentsList.push('range: String? = null');
 const response=op.responses['200']||op.responses['204'];
 const json=response?.content?.['application/json']?.schema;
 const result=json?type(json,name+'Response'):'ByteArray';
 const segments=url.split('/').filter(Boolean).map(segment=>segment.startsWith('{')?`addPathSegment(${safe(segment.slice(1,-1))})`:`addPathSegment(${JSON.stringify(segment)})`).join('.');
 const queries=queryParams.map(p=>`        query.${safe(p.name)}${p.required?'.let':'?.let'} { url.addQueryParameter(${JSON.stringify(p.name)}, it.toString()) }`).join('\n');
 methods.push(`    fun ${safe(op.operationId)}(${argumentsList.join(', ')}): ${json ? `ApiResponse<${result}>` : 'okhttp3.Response'} {\n        val url = baseUrl.toHttpUrl().newBuilder().${segments}\n${queries}\n        return ${json ? 'execute' : 'executeStream'}(url.build().toString(), ${JSON.stringify(method.toUpperCase())}, ${bodyName?'json.encodeToString(body)':'null'}, ${params.some(p=>p.in==='header'&&p.name==='Range')?'range':'null'})\n    }`);
}
const header='// Generated from contract/openapi.json. Do not edit.\npackage uk.eckonet.homestream.api\n\n';
fs.writeFileSync(path.join(output,'Models.kt'),header+'import kotlinx.serialization.Serializable\nimport kotlinx.serialization.SerialName\nimport kotlinx.serialization.json.JsonElement\n\n'+[...classes.values()].join('\n\n')+'\n');
fs.writeFileSync(path.join(output,'HomeStreamClient.kt'),header+`import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

data class ApiResponse<T>(val status: Int, val body: T?, val bytes: ByteArray)
/** Blocking calls: invoke off the Android main thread. Tokens are never logged. */
class HomeStreamClient(private val baseUrl: String, private val bearerToken: String? = null, private val http: OkHttpClient = OkHttpClient()) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    /** Caller owns the returned response and must close it; media bodies are streamed. */
    private fun executeStream(url: String, method: String, body: String?, range: String?): okhttp3.Response {
        val request = Request.Builder().url(url).method(method, body?.toRequestBody("application/json".toMediaType()))
        bearerToken?.let { request.header("Authorization", "Bearer $it") }
        range?.let { request.header("Range", it) }
        return http.newCall(request.build()).execute()
    }
    private inline fun <reified T> execute(url: String, method: String, body: String?, range: String?): ApiResponse<T> {
        val request = Request.Builder().url(url).method(method, body?.toRequestBody("application/json".toMediaType()))
        bearerToken?.let { request.header("Authorization", "Bearer $it") }
        range?.let { request.header("Range", it) }
        return http.newCall(request.build()).execute().use { response ->
            val bytes = response.body.bytes()
            val decoded: T? = if (!response.isSuccessful || bytes.isEmpty()) null else if (response.header("Content-Type")?.contains("application/json") == true) json.decodeFromString<T>(bytes.decodeToString()) else null
            ApiResponse(response.code, decoded, bytes)
        }
    }
${methods.join('\n\n')}
}
`);
fs.writeFileSync('contract/kotlin/build.gradle',`group 'uk.eckonet.homestream'
version '${spec.info.version}'
buildscript {
    ext.kotlin_version = '2.2.20'
    repositories { mavenCentral() }
    dependencies {
        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlin_version"
        classpath "org.jetbrains.kotlin:kotlin-serialization:$kotlin_version"
    }
}
apply plugin: 'kotlin'
apply plugin: 'kotlinx-serialization'
repositories { mavenCentral() }
java { sourceCompatibility = JavaVersion.VERSION_1_8; targetCompatibility = JavaVersion.VERSION_1_8 }
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_1_8) } }
dependencies {
    implementation "org.jetbrains.kotlin:kotlin-stdlib-jdk8:$kotlin_version"
    implementation "org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0"
    implementation "com.squareup.okhttp3:okhttp:5.1.0"
}
`);
console.info(`Generated ${classes.size} Kotlin model types and ${methods.length} client operations`);
