// Generated from contract/openapi.json. Do not edit.
package uk.eckonet.homestream.api

import kotlinx.serialization.encodeToString
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
    fun `web_get_auth`(query: WebGetAuthQuery): ApiResponse<WebGetAuthResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("auth")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`action`?.let { url.addQueryParameter("action", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_post_auth`(query: WebPostAuthQuery, body: WebPostAuthBody): ApiResponse<WebPostAuthResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("auth")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_get_config`(query: WebGetConfigQuery): ApiResponse<PublicConfig> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("config")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_post_config`(query: WebPostConfigQuery, body: WebPostConfigBody): ApiResponse<WebPostConfigResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("config")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`action`?.let { url.addQueryParameter("action", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_get_home`(query: WebGetHomeQuery): ApiResponse<HomeResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("home")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_get_library_type_`(`type`: String, query: WebGetLibraryTypeQuery): ApiResponse<LibraryResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("library").addPathSegment(`type`)
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`search`?.let { url.addQueryParameter("search", it.toString()) }
        query.`letter`?.let { url.addQueryParameter("letter", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_get_categories_type_`(`type`: String, query: WebGetCategoriesTypeQuery): ApiResponse<WebGetCategoriesTypeResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("categories").addPathSegment(`type`)
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_get_media_id_`(`id`: String, query: WebGetMediaIdQuery): ApiResponse<MediaResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("media").addPathSegment(`id`)
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`type`?.let { url.addQueryParameter("type", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_get_media_id_recommendations`(`id`: String, query: WebGetMediaIdRecommendationsQuery): ApiResponse<WebGetMediaIdRecommendationsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("media").addPathSegment(`id`).addPathSegment("recommendations")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`tmdbId`?.let { url.addQueryParameter("tmdbId", it.toString()) }
        query.`type`?.let { url.addQueryParameter("type", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_get_profiles`(query: WebGetProfilesQuery): ApiResponse<ProfilesResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("profiles")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`includeAvailable`?.let { url.addQueryParameter("includeAvailable", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_post_profiles`(query: WebPostProfilesQuery, body: WebPostProfilesBody): ApiResponse<WebPostProfilesResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("profiles")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_get_search`(query: WebGetSearchQuery): ApiResponse<WebGetSearchResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("search")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`q`?.let { url.addQueryParameter("q", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_get_downloads`(query: WebGetDownloadsQuery): ApiResponse<WebGetDownloadsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("downloads")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_get_playback`(query: WebGetPlaybackQuery): ApiResponse<PlaybackResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("playback")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`itemId`.let { url.addQueryParameter("itemId", it.toString()) }
        query.`startTimeTicks`?.let { url.addQueryParameter("startTimeTicks", it.toString()) }
        query.`forceTranscode`?.let { url.addQueryParameter("forceTranscode", it.toString()) }
        query.`canPlayHevc`?.let { url.addQueryParameter("canPlayHevc", it.toString()) }
        query.`receiver`?.let { url.addQueryParameter("receiver", it.toString()) }
        query.`videoCodecs`?.let { url.addQueryParameter("videoCodecs", it.toString()) }
        query.`audioCodecs`?.let { url.addQueryParameter("audioCodecs", it.toString()) }
        query.`videoCapabilities`?.let { url.addQueryParameter("videoCapabilities", it.toString()) }
        query.`maxWidth`?.let { url.addQueryParameter("maxWidth", it.toString()) }
        query.`maxHeight`?.let { url.addQueryParameter("maxHeight", it.toString()) }
        query.`tmdbId`?.let { url.addQueryParameter("tmdbId", it.toString()) }
        query.`type`?.let { url.addQueryParameter("type", it.toString()) }
        query.`season`?.let { url.addQueryParameter("season", it.toString()) }
        query.`episode`?.let { url.addQueryParameter("episode", it.toString()) }
        query.`title`?.let { url.addQueryParameter("title", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_post_playback_progress`(query: WebPostPlaybackProgressQuery, body: WebPostPlaybackProgressBody): ApiResponse<WebPostPlaybackProgressResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("playback").addPathSegment("progress")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_get_request`(query: WebGetRequestQuery): ApiResponse<WebGetRequestResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("request")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`type`?.let { url.addQueryParameter("type", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_post_request`(query: WebPostRequestQuery, body: WebPostRequestBody): ApiResponse<WebPostRequestResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("request")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_get_preview_stream`(query: WebGetPreviewStreamQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("preview-stream")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`itemId`.let { url.addQueryParameter("itemId", it.toString()) }
        query.`ticks`?.let { url.addQueryParameter("ticks", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `web_get_subtitles`(query: WebGetSubtitlesQuery): ApiResponse<WebGetSubtitlesResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("subtitles")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`itemId`.let { url.addQueryParameter("itemId", it.toString()) }
        query.`mediaSourceId`?.let { url.addQueryParameter("mediaSourceId", it.toString()) }
        query.`index`?.let { url.addQueryParameter("index", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_get_trailer`(query: WebGetTrailerQuery): ApiResponse<WebGetTrailerResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("trailer")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`itemId`?.let { url.addQueryParameter("itemId", it.toString()) }
        query.`tmdbId`?.let { url.addQueryParameter("tmdbId", it.toString()) }
        query.`type`?.let { url.addQueryParameter("type", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_get_stream_download`(query: WebGetStreamDownloadQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("stream").addPathSegment("download")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`hash`?.let { url.addQueryParameter("hash", it.toString()) }
        query.`path`?.let { url.addQueryParameter("path", it.toString()) }
        query.`fileIndex`?.let { url.addQueryParameter("fileIndex", it.toString()) }
        query.`season`?.let { url.addQueryParameter("season", it.toString()) }
        query.`episode`?.let { url.addQueryParameter("episode", it.toString()) }
        query.`start`?.let { url.addQueryParameter("start", it.toString()) }
        query.`transcode`?.let { url.addQueryParameter("transcode", it.toString()) }
        query.`native`?.let { url.addQueryParameter("native", it.toString()) }
        query.`source`?.let { url.addQueryParameter("source", it.toString()) }
        query.`probe`?.let { url.addQueryParameter("probe", it.toString()) }
        query.`growing`?.let { url.addQueryParameter("growing", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `web_get_stream_torrent`(query: WebGetStreamTorrentQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("stream").addPathSegment("torrent")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`tmdbId`?.let { url.addQueryParameter("tmdbId", it.toString()) }
        query.`type`?.let { url.addQueryParameter("type", it.toString()) }
        query.`season`?.let { url.addQueryParameter("season", it.toString()) }
        query.`episode`?.let { url.addQueryParameter("episode", it.toString()) }
        query.`title`?.let { url.addQueryParameter("title", it.toString()) }
        query.`magnet`?.let { url.addQueryParameter("magnet", it.toString()) }
        query.`forceTranscode`?.let { url.addQueryParameter("forceTranscode", it.toString()) }
        query.`canPlayHevc`?.let { url.addQueryParameter("canPlayHevc", it.toString()) }
        query.`receiver`?.let { url.addQueryParameter("receiver", it.toString()) }
        query.`start`?.let { url.addQueryParameter("start", it.toString()) }
        query.`transcode`?.let { url.addQueryParameter("transcode", it.toString()) }
        query.`native`?.let { url.addQueryParameter("native", it.toString()) }
        query.`source`?.let { url.addQueryParameter("source", it.toString()) }
        query.`probe`?.let { url.addQueryParameter("probe", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `web_get_webhook_arr`(query: WebGetWebhookArrQuery): ApiResponse<WebGetWebhookArrResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("webhook").addPathSegment("arr")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_post_webhook_arr`(query: WebPostWebhookArrQuery, body: WebPostWebhookArrBody): ApiResponse<WebPostWebhookArrResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("webhook").addPathSegment("arr")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_get_catalog_links`(query: WebGetCatalogLinksQuery): ApiResponse<WebGetCatalogLinksResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("catalog-links")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_get_music`(query: WebGetMusicQuery): ApiResponse<MusicResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`q`?.let { url.addQueryParameter("q", it.toString()) }
        query.`offset`?.let { url.addQueryParameter("offset", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_get_music_album`(query: WebGetMusicAlbumQuery): ApiResponse<MusicAlbumResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("album")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`albumId`.let { url.addQueryParameter("albumId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_delete_music_album`(query: WebDeleteMusicAlbumQuery): ApiResponse<WebDeleteMusicAlbumResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("album")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`albumId`?.let { url.addQueryParameter("albumId", it.toString()) }
        return execute(url.build().toString(), "DELETE", null, null)
    }

    fun `web_get_music_artwork`(query: WebGetMusicArtworkQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("artwork")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`albumId`.let { url.addQueryParameter("albumId", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `web_get_music_stream`(query: WebGetMusicStreamQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("stream")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`trackId`.let { url.addQueryParameter("trackId", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `web_get_music_download`(query: WebGetMusicDownloadQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("download")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`trackId`?.let { url.addQueryParameter("trackId", it.toString()) }
        query.`albumId`?.let { url.addQueryParameter("albumId", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `web_get_music_import_status`(query: WebGetMusicImportStatusQuery): ApiResponse<WebGetMusicImportStatusResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("import-status")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_post_music_request`(query: WebPostMusicRequestQuery, body: WebPostMusicRequestBody): ApiResponse<WebPostMusicRequestResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("request")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_post_music_profile_album`(query: WebPostMusicProfileAlbumQuery, body: WebPostMusicProfileAlbumBody): ApiResponse<WebPostMusicProfileAlbumResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("profile-album")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_delete_music_profile_album`(query: WebDeleteMusicProfileAlbumQuery): ApiResponse<WebDeleteMusicProfileAlbumResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("profile-album")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`albumId`?.let { url.addQueryParameter("albumId", it.toString()) }
        return execute(url.build().toString(), "DELETE", null, null)
    }

    fun `web_get_music_playlists`(query: WebGetMusicPlaylistsQuery): ApiResponse<JsonElement> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("playlists")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`profileId`?.let { url.addQueryParameter("profileId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_post_music_playlists`(query: WebPostMusicPlaylistsQuery, body: WebPostMusicPlaylistsBody): ApiResponse<WebPostMusicPlaylistsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("playlists")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_post_music_playlists_import`(query: WebPostMusicPlaylistsImportQuery, body: WebPostMusicPlaylistsImportBody): ApiResponse<WebPostMusicPlaylistsImportResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("playlists").addPathSegment("import")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_post_music_playlists_import_spotify`(query: WebPostMusicPlaylistsImportSpotifyQuery, body: WebPostMusicPlaylistsImportSpotifyBody): ApiResponse<WebPostMusicPlaylistsImportSpotifyResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("playlists").addPathSegment("import-spotify")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_post_music_playlists_import_exportify`(query: WebPostMusicPlaylistsImportExportifyQuery, body: WebPostMusicPlaylistsImportExportifyBody): ApiResponse<WebPostMusicPlaylistsImportExportifyResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("playlists").addPathSegment("import-exportify")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_get_music_playlist`(query: WebGetMusicPlaylistQuery, body: JsonElement): ApiResponse<JsonElement> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("playlist")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`playlistId`?.let { url.addQueryParameter("playlistId", it.toString()) }
        return execute(url.build().toString(), "GET", json.encodeToString(body), null)
    }

    fun `web_delete_music_playlist`(query: WebDeleteMusicPlaylistQuery, body: JsonElement): ApiResponse<WebDeleteMusicPlaylistResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("playlist")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`playlistId`?.let { url.addQueryParameter("playlistId", it.toString()) }
        return execute(url.build().toString(), "DELETE", json.encodeToString(body), null)
    }

    fun `web_post_music_playlist_track`(query: WebPostMusicPlaylistTrackQuery, body: WebPostMusicPlaylistTrackBody): ApiResponse<WebPostMusicPlaylistTrackResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("playlist").addPathSegment("track")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_delete_music_playlist_track`(query: WebDeleteMusicPlaylistTrackQuery, body: JsonElement): ApiResponse<WebDeleteMusicPlaylistTrackResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("music").addPathSegment("playlist").addPathSegment("track")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`playlistId`?.let { url.addQueryParameter("playlistId", it.toString()) }
        query.`trackId`?.let { url.addQueryParameter("trackId", it.toString()) }
        return execute(url.build().toString(), "DELETE", json.encodeToString(body), null)
    }

    fun `web_get_requested`(query: WebGetRequestedQuery): ApiResponse<RequestedResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("requested")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_get_integrations`(query: WebGetIntegrationsQuery): ApiResponse<IntegrationsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("integrations")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_post_integrations`(query: WebPostIntegrationsQuery, body: WebPostIntegrationsBody): ApiResponse<JsonElement> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("integrations")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_get_youtube_search`(query: WebGetYoutubeSearchQuery): ApiResponse<YouTubeSearchResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("search")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`q`?.let { url.addQueryParameter("q", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_get_youtube_stream`(query: WebGetYoutubeStreamQuery): ApiResponse<YouTubeStreamResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("stream")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`videoId`.let { url.addQueryParameter("videoId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_get_youtube_stream_video`(query: WebGetYoutubeStreamVideoQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("stream-video")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`videoId`.let { url.addQueryParameter("videoId", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `web_post_youtube_progress`(query: WebPostYoutubeProgressQuery, body: WebPostYoutubeProgressBody): ApiResponse<WebPostYoutubeProgressResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("progress")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_get_youtube_continue_watching`(query: WebGetYoutubeContinueWatchingQuery): ApiResponse<WebGetYoutubeContinueWatchingResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("continue-watching")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_delete_youtube_continue_watching`(query: WebDeleteYoutubeContinueWatchingQuery): ApiResponse<WebDeleteYoutubeContinueWatchingResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("continue-watching")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`videoId`.let { url.addQueryParameter("videoId", it.toString()) }
        return execute(url.build().toString(), "DELETE", null, null)
    }

    fun `web_get_youtube_auth`(query: WebGetYoutubeAuthQuery): ApiResponse<WebGetYoutubeAuthResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("auth")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_post_youtube_auth`(query: WebPostYoutubeAuthQuery, body: WebPostYoutubeAuthBody): ApiResponse<WebPostYoutubeAuthResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("auth")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_delete_youtube_auth`(query: WebDeleteYoutubeAuthQuery): ApiResponse<WebDeleteYoutubeAuthResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("auth")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "DELETE", null, null)
    }

    fun `web_get_youtube_recommendations`(query: WebGetYoutubeRecommendationsQuery): ApiResponse<WebGetYoutubeRecommendationsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("recommendations")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_post_youtube_download`(query: WebPostYoutubeDownloadQuery, body: WebPostYoutubeDownloadBody): ApiResponse<WebPostYoutubeDownloadResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("download")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_get_youtube_subscriptions`(query: WebGetYoutubeSubscriptionsQuery): ApiResponse<YouTubeSubscriptionsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("subscriptions")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_post_youtube_subscriptions`(query: WebPostYoutubeSubscriptionsQuery, body: WebPostYoutubeSubscriptionsBody): ApiResponse<WebPostYoutubeSubscriptionsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("subscriptions")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_put_youtube_subscriptions`(query: WebPutYoutubeSubscriptionsQuery, body: WebPutYoutubeSubscriptionsBody): ApiResponse<WebPutYoutubeSubscriptionsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("subscriptions")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "PUT", json.encodeToString(body), null)
    }

    fun `web_delete_youtube_subscriptions`(query: WebDeleteYoutubeSubscriptionsQuery): ApiResponse<WebDeleteYoutubeSubscriptionsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("subscriptions")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`id`.let { url.addQueryParameter("id", it.toString()) }
        return execute(url.build().toString(), "DELETE", null, null)
    }

    fun `web_post_youtube_subscriptions_check`(query: WebPostYoutubeSubscriptionsCheckQuery, body: WebPostYoutubeSubscriptionsCheckBody): ApiResponse<WebPostYoutubeSubscriptionsCheckResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("subscriptions").addPathSegment("check")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `web_get_youtube_queue`(query: WebGetYoutubeQueueQuery): ApiResponse<YouTubeQueueResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("queue")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_delete_youtube_queue`(query: WebDeleteYoutubeQueueQuery): ApiResponse<WebDeleteYoutubeQueueResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("queue")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`videoId`.let { url.addQueryParameter("videoId", it.toString()) }
        return execute(url.build().toString(), "DELETE", null, null)
    }

    fun `web_get_youtube_archive`(query: WebGetYoutubeArchiveQuery): ApiResponse<YouTubeArchiveResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("archive")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `web_get_youtube_stream_local`(query: WebGetYoutubeStreamLocalQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("stream-local")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`path`.let { url.addQueryParameter("path", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `web_get_youtube_thumbnail`(query: WebGetYoutubeThumbnailQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("v1").addPathSegment("youtube").addPathSegment("thumbnail")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`path`.let { url.addQueryParameter("path", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `mobile_get_home`(query: MobileGetHomeQuery): ApiResponse<HomeResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("home")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_library_type_`(`type`: String, query: MobileGetLibraryTypeQuery): ApiResponse<LibraryResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("library").addPathSegment(`type`)
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`search`?.let { url.addQueryParameter("search", it.toString()) }
        query.`letter`?.let { url.addQueryParameter("letter", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_categories_type_`(`type`: String, query: MobileGetCategoriesTypeQuery): ApiResponse<MobileGetCategoriesTypeResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("categories").addPathSegment(`type`)
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_media_id_`(`id`: String, query: MobileGetMediaIdQuery): ApiResponse<MediaResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("media").addPathSegment(`id`)
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`type`?.let { url.addQueryParameter("type", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_media_id_recommendations`(`id`: String, query: MobileGetMediaIdRecommendationsQuery): ApiResponse<MobileGetMediaIdRecommendationsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("media").addPathSegment(`id`).addPathSegment("recommendations")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`tmdbId`?.let { url.addQueryParameter("tmdbId", it.toString()) }
        query.`type`?.let { url.addQueryParameter("type", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_search`(query: MobileGetSearchQuery): ApiResponse<MobileGetSearchResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("search")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`q`?.let { url.addQueryParameter("q", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_downloads`(query: MobileGetDownloadsQuery): ApiResponse<MobileGetDownloadsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("downloads")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_playback`(query: MobileGetPlaybackQuery): ApiResponse<PlaybackResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("playback")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`itemId`.let { url.addQueryParameter("itemId", it.toString()) }
        query.`startTimeTicks`?.let { url.addQueryParameter("startTimeTicks", it.toString()) }
        query.`forceTranscode`?.let { url.addQueryParameter("forceTranscode", it.toString()) }
        query.`canPlayHevc`?.let { url.addQueryParameter("canPlayHevc", it.toString()) }
        query.`receiver`?.let { url.addQueryParameter("receiver", it.toString()) }
        query.`videoCodecs`?.let { url.addQueryParameter("videoCodecs", it.toString()) }
        query.`audioCodecs`?.let { url.addQueryParameter("audioCodecs", it.toString()) }
        query.`videoCapabilities`?.let { url.addQueryParameter("videoCapabilities", it.toString()) }
        query.`maxWidth`?.let { url.addQueryParameter("maxWidth", it.toString()) }
        query.`maxHeight`?.let { url.addQueryParameter("maxHeight", it.toString()) }
        query.`tmdbId`?.let { url.addQueryParameter("tmdbId", it.toString()) }
        query.`type`?.let { url.addQueryParameter("type", it.toString()) }
        query.`season`?.let { url.addQueryParameter("season", it.toString()) }
        query.`episode`?.let { url.addQueryParameter("episode", it.toString()) }
        query.`title`?.let { url.addQueryParameter("title", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_request`(query: MobileGetRequestQuery): ApiResponse<MobileGetRequestResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("request")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`type`?.let { url.addQueryParameter("type", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_post_request`(query: MobilePostRequestQuery, body: MobilePostRequestBody): ApiResponse<MobilePostRequestResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("request")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_get_subtitles`(query: MobileGetSubtitlesQuery): ApiResponse<MobileGetSubtitlesResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("subtitles")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`itemId`.let { url.addQueryParameter("itemId", it.toString()) }
        query.`mediaSourceId`?.let { url.addQueryParameter("mediaSourceId", it.toString()) }
        query.`index`?.let { url.addQueryParameter("index", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_trailer`(query: MobileGetTrailerQuery): ApiResponse<MobileGetTrailerResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("trailer")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`itemId`?.let { url.addQueryParameter("itemId", it.toString()) }
        query.`tmdbId`?.let { url.addQueryParameter("tmdbId", it.toString()) }
        query.`type`?.let { url.addQueryParameter("type", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_stream_download`(query: MobileGetStreamDownloadQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("stream").addPathSegment("download")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`hash`?.let { url.addQueryParameter("hash", it.toString()) }
        query.`path`?.let { url.addQueryParameter("path", it.toString()) }
        query.`fileIndex`?.let { url.addQueryParameter("fileIndex", it.toString()) }
        query.`season`?.let { url.addQueryParameter("season", it.toString()) }
        query.`episode`?.let { url.addQueryParameter("episode", it.toString()) }
        query.`start`?.let { url.addQueryParameter("start", it.toString()) }
        query.`transcode`?.let { url.addQueryParameter("transcode", it.toString()) }
        query.`native`?.let { url.addQueryParameter("native", it.toString()) }
        query.`source`?.let { url.addQueryParameter("source", it.toString()) }
        query.`probe`?.let { url.addQueryParameter("probe", it.toString()) }
        query.`growing`?.let { url.addQueryParameter("growing", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `mobile_get_stream_torrent`(query: MobileGetStreamTorrentQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("stream").addPathSegment("torrent")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`tmdbId`?.let { url.addQueryParameter("tmdbId", it.toString()) }
        query.`type`?.let { url.addQueryParameter("type", it.toString()) }
        query.`season`?.let { url.addQueryParameter("season", it.toString()) }
        query.`episode`?.let { url.addQueryParameter("episode", it.toString()) }
        query.`title`?.let { url.addQueryParameter("title", it.toString()) }
        query.`magnet`?.let { url.addQueryParameter("magnet", it.toString()) }
        query.`forceTranscode`?.let { url.addQueryParameter("forceTranscode", it.toString()) }
        query.`canPlayHevc`?.let { url.addQueryParameter("canPlayHevc", it.toString()) }
        query.`receiver`?.let { url.addQueryParameter("receiver", it.toString()) }
        query.`start`?.let { url.addQueryParameter("start", it.toString()) }
        query.`transcode`?.let { url.addQueryParameter("transcode", it.toString()) }
        query.`native`?.let { url.addQueryParameter("native", it.toString()) }
        query.`source`?.let { url.addQueryParameter("source", it.toString()) }
        query.`probe`?.let { url.addQueryParameter("probe", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `mobile_get_music`(query: MobileGetMusicQuery): ApiResponse<MusicResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`q`?.let { url.addQueryParameter("q", it.toString()) }
        query.`offset`?.let { url.addQueryParameter("offset", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_music_album`(query: MobileGetMusicAlbumQuery): ApiResponse<MusicAlbumResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("album")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`albumId`.let { url.addQueryParameter("albumId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_delete_music_album`(query: MobileDeleteMusicAlbumQuery): ApiResponse<MobileDeleteMusicAlbumResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("album")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`albumId`?.let { url.addQueryParameter("albumId", it.toString()) }
        return execute(url.build().toString(), "DELETE", null, null)
    }

    fun `mobile_get_music_artwork`(query: MobileGetMusicArtworkQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("artwork")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`albumId`.let { url.addQueryParameter("albumId", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `mobile_get_music_stream`(query: MobileGetMusicStreamQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("stream")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`trackId`.let { url.addQueryParameter("trackId", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `mobile_get_music_download`(query: MobileGetMusicDownloadQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("download")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`trackId`?.let { url.addQueryParameter("trackId", it.toString()) }
        query.`albumId`?.let { url.addQueryParameter("albumId", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `mobile_get_music_import_status`(query: MobileGetMusicImportStatusQuery): ApiResponse<MobileGetMusicImportStatusResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("import-status")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_post_music_request`(query: MobilePostMusicRequestQuery, body: MobilePostMusicRequestBody): ApiResponse<MobilePostMusicRequestResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("request")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_post_music_profile_album`(query: MobilePostMusicProfileAlbumQuery, body: MobilePostMusicProfileAlbumBody): ApiResponse<MobilePostMusicProfileAlbumResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("profile-album")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_delete_music_profile_album`(query: MobileDeleteMusicProfileAlbumQuery): ApiResponse<MobileDeleteMusicProfileAlbumResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("profile-album")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`albumId`?.let { url.addQueryParameter("albumId", it.toString()) }
        return execute(url.build().toString(), "DELETE", null, null)
    }

    fun `mobile_get_music_playlists`(query: MobileGetMusicPlaylistsQuery): ApiResponse<JsonElement> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("playlists")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`profileId`?.let { url.addQueryParameter("profileId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_post_music_playlists`(query: MobilePostMusicPlaylistsQuery, body: MobilePostMusicPlaylistsBody): ApiResponse<MobilePostMusicPlaylistsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("playlists")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_post_music_playlists_import`(query: MobilePostMusicPlaylistsImportQuery, body: MobilePostMusicPlaylistsImportBody): ApiResponse<MobilePostMusicPlaylistsImportResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("playlists").addPathSegment("import")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_post_music_playlists_import_spotify`(query: MobilePostMusicPlaylistsImportSpotifyQuery, body: MobilePostMusicPlaylistsImportSpotifyBody): ApiResponse<MobilePostMusicPlaylistsImportSpotifyResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("playlists").addPathSegment("import-spotify")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_post_music_playlists_import_exportify`(query: MobilePostMusicPlaylistsImportExportifyQuery, body: MobilePostMusicPlaylistsImportExportifyBody): ApiResponse<MobilePostMusicPlaylistsImportExportifyResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("playlists").addPathSegment("import-exportify")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_get_music_playlist`(query: MobileGetMusicPlaylistQuery, body: JsonElement): ApiResponse<JsonElement> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("playlist")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`playlistId`?.let { url.addQueryParameter("playlistId", it.toString()) }
        return execute(url.build().toString(), "GET", json.encodeToString(body), null)
    }

    fun `mobile_delete_music_playlist`(query: MobileDeleteMusicPlaylistQuery, body: JsonElement): ApiResponse<MobileDeleteMusicPlaylistResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("playlist")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`playlistId`?.let { url.addQueryParameter("playlistId", it.toString()) }
        return execute(url.build().toString(), "DELETE", json.encodeToString(body), null)
    }

    fun `mobile_post_music_playlist_track`(query: MobilePostMusicPlaylistTrackQuery, body: MobilePostMusicPlaylistTrackBody): ApiResponse<MobilePostMusicPlaylistTrackResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("playlist").addPathSegment("track")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_delete_music_playlist_track`(query: MobileDeleteMusicPlaylistTrackQuery, body: JsonElement): ApiResponse<MobileDeleteMusicPlaylistTrackResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("music").addPathSegment("playlist").addPathSegment("track")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`playlistId`?.let { url.addQueryParameter("playlistId", it.toString()) }
        query.`trackId`?.let { url.addQueryParameter("trackId", it.toString()) }
        return execute(url.build().toString(), "DELETE", json.encodeToString(body), null)
    }

    fun `mobile_get_requested`(query: MobileGetRequestedQuery): ApiResponse<RequestedResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("requested")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_integrations`(query: MobileGetIntegrationsQuery): ApiResponse<IntegrationsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("integrations")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_post_integrations`(query: MobilePostIntegrationsQuery, body: MobilePostIntegrationsBody): ApiResponse<JsonElement> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("integrations")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_get_youtube_search`(query: MobileGetYoutubeSearchQuery): ApiResponse<YouTubeSearchResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("search")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`q`?.let { url.addQueryParameter("q", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_youtube_stream`(query: MobileGetYoutubeStreamQuery): ApiResponse<YouTubeStreamResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("stream")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`videoId`.let { url.addQueryParameter("videoId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_youtube_stream_video`(query: MobileGetYoutubeStreamVideoQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("stream-video")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`videoId`.let { url.addQueryParameter("videoId", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `mobile_post_youtube_progress`(query: MobilePostYoutubeProgressQuery, body: MobilePostYoutubeProgressBody): ApiResponse<MobilePostYoutubeProgressResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("progress")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_get_youtube_continue_watching`(query: MobileGetYoutubeContinueWatchingQuery): ApiResponse<MobileGetYoutubeContinueWatchingResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("continue-watching")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_delete_youtube_continue_watching`(query: MobileDeleteYoutubeContinueWatchingQuery): ApiResponse<MobileDeleteYoutubeContinueWatchingResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("continue-watching")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`videoId`.let { url.addQueryParameter("videoId", it.toString()) }
        return execute(url.build().toString(), "DELETE", null, null)
    }

    fun `mobile_get_youtube_auth`(query: MobileGetYoutubeAuthQuery): ApiResponse<MobileGetYoutubeAuthResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("auth")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_post_youtube_auth`(query: MobilePostYoutubeAuthQuery, body: MobilePostYoutubeAuthBody): ApiResponse<MobilePostYoutubeAuthResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("auth")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_delete_youtube_auth`(query: MobileDeleteYoutubeAuthQuery): ApiResponse<MobileDeleteYoutubeAuthResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("auth")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "DELETE", null, null)
    }

    fun `mobile_get_youtube_recommendations`(query: MobileGetYoutubeRecommendationsQuery): ApiResponse<MobileGetYoutubeRecommendationsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("recommendations")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_post_youtube_download`(query: MobilePostYoutubeDownloadQuery, body: MobilePostYoutubeDownloadBody): ApiResponse<MobilePostYoutubeDownloadResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("download")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_get_youtube_subscriptions`(query: MobileGetYoutubeSubscriptionsQuery): ApiResponse<YouTubeSubscriptionsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("subscriptions")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_post_youtube_subscriptions`(query: MobilePostYoutubeSubscriptionsQuery, body: MobilePostYoutubeSubscriptionsBody): ApiResponse<MobilePostYoutubeSubscriptionsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("subscriptions")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_put_youtube_subscriptions`(query: MobilePutYoutubeSubscriptionsQuery, body: MobilePutYoutubeSubscriptionsBody): ApiResponse<MobilePutYoutubeSubscriptionsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("subscriptions")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "PUT", json.encodeToString(body), null)
    }

    fun `mobile_delete_youtube_subscriptions`(query: MobileDeleteYoutubeSubscriptionsQuery): ApiResponse<MobileDeleteYoutubeSubscriptionsResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("subscriptions")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`id`.let { url.addQueryParameter("id", it.toString()) }
        return execute(url.build().toString(), "DELETE", null, null)
    }

    fun `mobile_post_youtube_subscriptions_check`(query: MobilePostYoutubeSubscriptionsCheckQuery, body: MobilePostYoutubeSubscriptionsCheckBody): ApiResponse<MobilePostYoutubeSubscriptionsCheckResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("subscriptions").addPathSegment("check")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_get_youtube_queue`(query: MobileGetYoutubeQueueQuery): ApiResponse<YouTubeQueueResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("queue")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_delete_youtube_queue`(query: MobileDeleteYoutubeQueueQuery): ApiResponse<MobileDeleteYoutubeQueueResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("queue")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`videoId`.let { url.addQueryParameter("videoId", it.toString()) }
        return execute(url.build().toString(), "DELETE", null, null)
    }

    fun `mobile_get_youtube_archive`(query: MobileGetYoutubeArchiveQuery): ApiResponse<YouTubeArchiveResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("archive")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_youtube_stream_local`(query: MobileGetYoutubeStreamLocalQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("stream-local")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`path`.let { url.addQueryParameter("path", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `mobile_get_youtube_thumbnail`(query: MobileGetYoutubeThumbnailQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("youtube").addPathSegment("thumbnail")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`path`.let { url.addQueryParameter("path", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `mobile_get_discovery`(query: MobileGetDiscoveryQuery): ApiResponse<MobileGetDiscoveryResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("discovery")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_capabilities`(query: MobileGetCapabilitiesQuery): ApiResponse<Capabilities> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("capabilities")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_auth_users`(query: MobileGetAuthUsersQuery): ApiResponse<MobileGetAuthUsersResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("auth").addPathSegment("users")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_post_auth_login`(query: MobilePostAuthLoginQuery, body: MobilePostAuthLoginBody): ApiResponse<MobilePostAuthLoginResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("auth").addPathSegment("login")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_post_auth_pair`(query: MobilePostAuthPairQuery, body: MobilePostAuthPairBody): ApiResponse<MobilePostAuthPairResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("auth").addPathSegment("pair")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_get_profiles`(query: MobileGetProfilesQuery): ApiResponse<MobileGetProfilesResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("profiles")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_post_profiles`(query: MobilePostProfilesQuery, body: MobilePostProfilesBody): ApiResponse<MobilePostProfilesResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("profiles")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_post_profiles_select`(query: MobilePostProfilesSelectQuery, body: MobilePostProfilesSelectBody): ApiResponse<MobilePostProfilesSelectResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("profiles").addPathSegment("select")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_get_profiles_status`(query: MobileGetProfilesStatusQuery): ApiResponse<MobileGetProfilesStatusResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("profiles").addPathSegment("status")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_session_status`(query: MobileGetSessionStatusQuery): ApiResponse<MobileGetSessionStatusResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("session").addPathSegment("status")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_profiles_users`(query: MobileGetProfilesUsersQuery): ApiResponse<MobileGetProfilesUsersResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("profiles").addPathSegment("users")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_post_profiles_users`(query: MobilePostProfilesUsersQuery, body: MobilePostProfilesUsersBody): ApiResponse<MobilePostProfilesUsersResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("profiles").addPathSegment("users")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_get_continue_watching`(query: MobileGetContinueWatchingQuery): ApiResponse<MobileGetContinueWatchingResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("continue-watching")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_episodes`(query: MobileGetEpisodesQuery): ApiResponse<MobileGetEpisodesResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("episodes")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`itemId`.let { url.addQueryParameter("itemId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_post_watched`(query: MobilePostWatchedQuery, body: MobilePostWatchedBody): ApiResponse<MobilePostWatchedResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("watched")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_post_progress`(query: MobilePostProgressQuery, body: MobilePostProgressBody): ApiResponse<MobilePostProgressResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("progress")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "POST", json.encodeToString(body), null)
    }

    fun `mobile_get_media_id_collection`(`id`: String, query: MobileGetMediaIdCollectionQuery): ApiResponse<MobileGetMediaIdCollectionResponse> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("media").addPathSegment(`id`).addPathSegment("collection")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        return execute(url.build().toString(), "GET", null, null)
    }

    fun `mobile_get_image`(query: MobileGetImageQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("image")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`itemId`?.let { url.addQueryParameter("itemId", it.toString()) }
        query.`url`?.let { url.addQueryParameter("url", it.toString()) }
        query.`type`?.let { url.addQueryParameter("type", it.toString()) }
        query.`tag`?.let { url.addQueryParameter("tag", it.toString()) }
        query.`maxWidth`?.let { url.addQueryParameter("maxWidth", it.toString()) }
        query.`maxHeight`?.let { url.addQueryParameter("maxHeight", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `mobile_get_parental_resource`(query: MobileGetParentalResourceQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("parental-resource")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`ticket`.let { url.addQueryParameter("ticket", it.toString()) }
        return executeStream(url.build().toString(), "GET", null, range)
    }

    fun `mobile_head_parental_resource`(query: MobileHeadParentalResourceQuery, range: String? = null): okhttp3.Response {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment("parental-resource")
        query.`userId`?.let { url.addQueryParameter("userId", it.toString()) }
        query.`ticket`.let { url.addQueryParameter("ticket", it.toString()) }
        return executeStream(url.build().toString(), "HEAD", null, range)
    }

    fun `mobile_options__path_`(`path`: String): ApiResponse<JsonElement> {
        val url = baseUrl.toHttpUrl().newBuilder().addPathSegment("api").addPathSegment("mobile").addPathSegment("v1").addPathSegment(`path`)

        return execute(url.build().toString(), "OPTIONS", null, null)
    }
}
