// Generated from contract/openapi.json. Do not edit.
package uk.eckonet.homestream.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.json.JsonElement

@Serializable
data class ApiError(
    @SerialName("error") val `error`: String
)

@Serializable
data class MediaItem(
    @SerialName("id") val `id`: String,
    @SerialName("title") val `title`: String,
    @SerialName("originalTitle") val `originalTitle`: String? = null,
    @SerialName("overview") val `overview`: String,
    @SerialName("type") val `type`: MediaType,
    @SerialName("posterUrl") val `posterUrl`: String,
    @SerialName("backdropUrl") val `backdropUrl`: String,
    @SerialName("year") val `year`: Double? = null,
    @SerialName("releaseDate") val `releaseDate`: String? = null,
    @SerialName("requestStatus") val `requestStatus`: String? = null,
    @SerialName("requestedAt") val `requestedAt`: String? = null,
    @SerialName("rating") val `rating`: String? = null,
    @SerialName("matchPercentage") val `matchPercentage`: Double? = null,
    @SerialName("communityRating") val `communityRating`: Double? = null,
    @SerialName("durationMinutes") val `durationMinutes`: Double? = null,
    @SerialName("genres") val `genres`: List<String>,
    @SerialName("seasonsCount") val `seasonsCount`: Double? = null,
    @SerialName("source") val `source`: String,
    @SerialName("jellyfinId") val `jellyfinId`: String? = null,
    @SerialName("seerrId") val `seerrId`: Double? = null,
    @SerialName("tmdbId") val `tmdbId`: Double? = null,
    @SerialName("playableEpisodeId") val `playableEpisodeId`: String? = null,
    @SerialName("status") val `status`: AvailabilityStatus,
    @SerialName("played") val `played`: Boolean? = null,
    @SerialName("playbackPositionTicks") val `playbackPositionTicks`: Double? = null,
    @SerialName("totalDurationTicks") val `totalDurationTicks`: Double? = null,
    @SerialName("progressPercent") val `progressPercent`: Double? = null,
    @SerialName("cast") val `cast`: List<CastMember>? = null,
    @SerialName("director") val `director`: String? = null,
    @SerialName("seriesId") val `seriesId`: String? = null,
    @SerialName("seasonNumber") val `seasonNumber`: Double? = null,
    @SerialName("episodeNumber") val `episodeNumber`: Double? = null,
    @SerialName("seriesName") val `seriesName`: String? = null,
    @SerialName("seasons") val `seasons`: List<Season>? = null,
    @SerialName("videoStreamUrl") val `videoStreamUrl`: String? = null,
    @SerialName("trailerKey") val `trailerKey`: String? = null,
    @SerialName("trailerUrl") val `trailerUrl`: String? = null,
    @SerialName("resolution") val `resolution`: String? = null,
    @SerialName("videoQuality") val `videoQuality`: String? = null,
    @SerialName("audioQuality") val `audioQuality`: String? = null,
    @SerialName("hasHdr") val `hasHdr`: Boolean? = null,
    @SerialName("isDownloading") val `isDownloading`: Boolean? = null,
    @SerialName("downloadProgress") val `downloadProgress`: Double? = null,
    @SerialName("downloadSpeed") val `downloadSpeed`: Double? = null,
    @SerialName("downloadEta") val `downloadEta`: Double? = null,
    @SerialName("downloaded") val `downloaded`: Double? = null,
    @SerialName("torrentHash") val `torrentHash`: String? = null,
    @SerialName("downloadStreamUrl") val `downloadStreamUrl`: String? = null,
    @SerialName("mediaFiles") val `mediaFiles`: List<DownloadingTorrentFile>? = null
)

typealias MediaType = String

typealias AvailabilityStatus = String

@Serializable
data class CastMember(
    @SerialName("name") val `name`: String,
    @SerialName("role") val `role`: String,
    @SerialName("profileUrl") val `profileUrl`: String? = null
)

@Serializable
data class Season(
    @SerialName("id") val `id`: String,
    @SerialName("seasonNumber") val `seasonNumber`: Double,
    @SerialName("name") val `name`: String,
    @SerialName("episodeCount") val `episodeCount`: Double,
    @SerialName("overview") val `overview`: String? = null,
    @SerialName("posterUrl") val `posterUrl`: String? = null,
    @SerialName("airDate") val `airDate`: String? = null,
    @SerialName("voteAverage") val `voteAverage`: Double? = null,
    @SerialName("episodes") val `episodes`: List<Episode>? = null
)

@Serializable
data class Episode(
    @SerialName("locationType") val `locationType`: String? = null,
    @SerialName("id") val `id`: String,
    @SerialName("episodeNumber") val `episodeNumber`: Double,
    @SerialName("seasonNumber") val `seasonNumber`: Double,
    @SerialName("name") val `name`: String,
    @SerialName("overview") val `overview`: String,
    @SerialName("durationMinutes") val `durationMinutes`: Double,
    @SerialName("thumbnailUrl") val `thumbnailUrl`: String,
    @SerialName("playbackPositionTicks") val `playbackPositionTicks`: Double? = null,
    @SerialName("totalDurationTicks") val `totalDurationTicks`: Double? = null,
    @SerialName("progressPercent") val `progressPercent`: Double? = null,
    @SerialName("played") val `played`: Boolean? = null,
    @SerialName("jellyfinId") val `jellyfinId`: String? = null,
    @SerialName("videoStreamUrl") val `videoStreamUrl`: String? = null,
    @SerialName("downloadStreamUrl") val `downloadStreamUrl`: String? = null,
    @SerialName("airDate") val `airDate`: String? = null,
    @SerialName("voteAverage") val `voteAverage`: Double? = null,
    @SerialName("tmdbId") val `tmdbId`: Double? = null,
    @SerialName("seriesId") val `seriesId`: String? = null,
    @SerialName("seriesName") val `seriesName`: String? = null
)

@Serializable
data class DownloadingTorrentFile(
    @SerialName("index") val `index`: Double,
    @SerialName("name") val `name`: String,
    @SerialName("size") val `size`: Double,
    @SerialName("progress") val `progress`: Double,
    @SerialName("isMedia") val `isMedia`: Boolean
)

@Serializable
data class MediaRowSection(
    @SerialName("id") val `id`: String,
    @SerialName("title") val `title`: String,
    @SerialName("items") val `items`: List<MediaItem>,
    @SerialName("isTop10") val `isTop10`: Boolean? = null
)

@Serializable
data class HomeResponse(
    @SerialName("hero") val `hero`: MediaItem? = null,
    @SerialName("sections") val `sections`: List<MediaRowSection>,
    @SerialName("requestSections") val `requestSections`: List<MediaRowSection>? = null,
    @SerialName("isDemoMode") val `isDemoMode`: Boolean
)

@Serializable
data class LibraryResponse(
    @SerialName("items") val `items`: List<MediaItem>,
    @SerialName("totalCount") val `totalCount`: Double? = null,
    @SerialName("filteredCount") val `filteredCount`: Double? = null,
    @SerialName("availableLetters") val `availableLetters`: List<String>? = null
)

@Serializable
data class MediaResponse(
    @SerialName("item") val `item`: MediaItem
)

@Serializable
data class UserProfile(
    @SerialName("isKids") val `isKids`: Boolean? = null,
    @SerialName("kidsDateOfBirth") val `kidsDateOfBirth`: String? = null,
    @SerialName("kidsRating") val `kidsRating`: String? = null,
    @SerialName("avatarId") val `avatarId`: String? = null,
    @SerialName("id") val `id`: String,
    @SerialName("name") val `name`: String,
    @SerialName("avatarColor") val `avatarColor`: String,
    @SerialName("avatarBg") val `avatarBg`: String,
    @SerialName("initials") val `initials`: String,
    @SerialName("avatarUrl") val `avatarUrl`: String? = null,
    @SerialName("isAdministrator") val `isAdministrator`: Boolean? = null,
    @SerialName("jellyfinUserId") val `jellyfinUserId`: String? = null
)

@Serializable
data class ProfilesResponse(
    @SerialName("profiles") val `profiles`: List<UserProfile>,
    @SerialName("activeProfileId") val `activeProfileId`: String? = null,
    @SerialName("canSwitchProfile") val `canSwitchProfile`: Boolean? = null,
    @SerialName("needsSetup") val `needsSetup`: Boolean? = null
)

@Serializable
data class PlaybackResponse(
    @SerialName("streamUrl") val `streamUrl`: String,
    @SerialName("isTranscoding") val `isTranscoding`: Boolean,
    @SerialName("durationSeconds") val `durationSeconds`: Double? = null,
    @SerialName("transport") val `transport`: String? = null,
    @SerialName("contentType") val `contentType`: String? = null
)

@Serializable
data class PublicConfig(
    @SerialName("appName") val `appName`: String,
    @SerialName("isConfigured") val `isConfigured`: Boolean,
    @SerialName("jellyfinUrl") val `jellyfinUrl`: String,
    @SerialName("hasJellyfinKey") val `hasJellyfinKey`: Boolean,
    @SerialName("jellyfinUserId") val `jellyfinUserId`: String,
    @SerialName("seerrUrl") val `seerrUrl`: String,
    @SerialName("hasSeerrKey") val `hasSeerrKey`: Boolean,
    @SerialName("qbittorrentUrl") val `qbittorrentUrl`: String? = null,
    @SerialName("qbittorrentUsername") val `qbittorrentUsername`: String? = null,
    @SerialName("hasQbittorrentPassword") val `hasQbittorrentPassword`: Boolean,
    @SerialName("downloadsPath") val `downloadsPath`: String,
    @SerialName("isJellyfinConfigured") val `isJellyfinConfigured`: Boolean,
    @SerialName("isSeerrConfigured") val `isSeerrConfigured`: Boolean,
    @SerialName("isQbittorrentConfigured") val `isQbittorrentConfigured`: Boolean,
    @SerialName("isSetupNeeded") val `isSetupNeeded`: Boolean,
    @SerialName("profilesCount") val `profilesCount`: Double
)

@Serializable
data class Capabilities(
    @SerialName("apiVersion") val `apiVersion`: Double,
    @SerialName("appName") val `appName`: String,
    @SerialName("cast") val `cast`: Boolean,
    @SerialName("jellyfinLogin") val `jellyfinLogin`: Boolean? = null,
    @SerialName("canManageIntegrations") val `canManageIntegrations`: Boolean? = null
)

@Serializable
data class RequestMediaPayload(
    @SerialName("mediaType") val `mediaType`: String,
    @SerialName("mediaId") val `mediaId`: Double,
    @SerialName("seasons") val `seasons`: JsonElement? = null,
    @SerialName("is4k") val `is4k`: Boolean? = null,
    @SerialName("profileId") val `profileId`: Double? = null,
    @SerialName("serverId") val `serverId`: Double? = null
)

@Serializable
data class SubtitleTrack(
    @SerialName("id") val `id`: String,
    @SerialName("index") val `index`: Double,
    @SerialName("title") val `title`: String,
    @SerialName("language") val `language`: String,
    @SerialName("isDefault") val `isDefault`: Boolean? = null,
    @SerialName("isForced") val `isForced`: Boolean? = null,
    @SerialName("src") val `src`: String
)

@Serializable
data class MusicAlbum(
    @SerialName("id") val `id`: String,
    @SerialName("title") val `title`: String,
    @SerialName("artist") val `artist`: String,
    @SerialName("year") val `year`: Double? = null,
    @SerialName("releaseDate") val `releaseDate`: String? = null,
    @SerialName("coverUrl") val `coverUrl`: String? = null,
    @SerialName("inLibrary") val `inLibrary`: Boolean,
    @SerialName("isDownloaded") val `isDownloaded`: Boolean? = null,
    @SerialName("requested") val `requested`: Boolean,
    @SerialName("trackCount") val `trackCount`: Double? = null
)

@Serializable
data class MusicTrack(
    @SerialName("id") val `id`: String,
    @SerialName("title") val `title`: String,
    @SerialName("artist") val `artist`: String,
    @SerialName("album") val `album`: String,
    @SerialName("trackNumber") val `trackNumber`: Double,
    @SerialName("discNumber") val `discNumber`: Double,
    @SerialName("durationSeconds") val `durationSeconds`: Double? = null,
    @SerialName("streamUrl") val `streamUrl`: String
)

@Serializable
data class MusicResponse(
    @SerialName("configured") val `configured`: Boolean,
    @SerialName("albums") val `albums`: List<MusicAlbum>,
    @SerialName("total") val `total`: Double
)

@Serializable
data class MusicAlbumResponse(
    @SerialName("album") val `album`: MusicAlbum,
    @SerialName("tracks") val `tracks`: List<MusicTrack>
)

@Serializable
data class RequestedItem(
    @SerialName("id") val `id`: String,
    @SerialName("title") val `title`: String,
    @SerialName("kind") val `kind`: String,
    @SerialName("source") val `source`: String,
    @SerialName("status") val `status`: String,
    @SerialName("artist") val `artist`: String? = null,
    @SerialName("posterUrl") val `posterUrl`: String? = null,
    @SerialName("releaseDate") val `releaseDate`: String? = null,
    @SerialName("requestedAt") val `requestedAt`: String? = null,
    @SerialName("progress") val `progress`: Double? = null,
    @SerialName("downloadSpeed") val `downloadSpeed`: Double? = null,
    @SerialName("etaSeconds") val `etaSeconds`: Double? = null,
    @SerialName("media") val `media`: MediaItem? = null
)

@Serializable
data class RequestedResponse(
    @SerialName("items") val `items`: List<RequestedItem>,
    @SerialName("warnings") val `warnings`: List<String>,
    @SerialName("updatedAt") val `updatedAt`: String
)

@Serializable
data class IntegrationSummary(
    @SerialName("id") val `id`: String,
    @SerialName("name") val `name`: String,
    @SerialName("url") val `url`: String,
    @SerialName("configured") val `configured`: Boolean,
    @SerialName("credentialSet") val `credentialSet`: Boolean,
    @SerialName("username") val `username`: String? = null
)

@Serializable
data class IntegrationsResponse(
    @SerialName("integrations") val `integrations`: List<IntegrationSummary>,
    @SerialName("downloadsPath") val `downloadsPath`: String
)

@Serializable
data class YouTubeSearchResult(
    @SerialName("id") val `id`: String,
    @SerialName("title") val `title`: String,
    @SerialName("channelId") val `channelId`: String,
    @SerialName("channelTitle") val `channelTitle`: String,
    @SerialName("channelAvatarUrl") val `channelAvatarUrl`: String? = null,
    @SerialName("durationSeconds") val `durationSeconds`: Double,
    @SerialName("durationFormatted") val `durationFormatted`: String,
    @SerialName("thumbnailUrl") val `thumbnailUrl`: String,
    @SerialName("uploadDate") val `uploadDate`: String? = null,
    @SerialName("viewCount") val `viewCount`: String? = null,
    @SerialName("description") val `description`: String? = null,
    @SerialName("isShort") val `isShort`: Boolean,
    @SerialName("isDownloaded") val `isDownloaded`: Boolean? = null
)

@Serializable
data class YouTubeSearchResponse(
    @SerialName("results") val `results`: List<YouTubeSearchResult>
)

@Serializable
data class YouTubeStreamResponse(
    @SerialName("videoId") val `videoId`: String,
    @SerialName("streamUrl") val `streamUrl`: String,
    @SerialName("title") val `title`: String? = null,
    @SerialName("durationSeconds") val `durationSeconds`: Double? = null
)

@Serializable
data class YouTubeSubscription(
    @SerialName("id") val `id`: String,
    @SerialName("title") val `title`: String,
    @SerialName("handle") val `handle`: String? = null,
    @SerialName("avatarUrl") val `avatarUrl`: String? = null,
    @SerialName("bannerUrl") val `bannerUrl`: String? = null,
    @SerialName("description") val `description`: String? = null,
    @SerialName("subscribedAt") val `subscribedAt`: String,
    @SerialName("autoDownload") val `autoDownload`: Boolean,
    @SerialName("minDurationSeconds") val `minDurationSeconds`: Double,
    @SerialName("maxDurationSeconds") val `maxDurationSeconds`: Double? = null,
    @SerialName("includeKeywords") val `includeKeywords`: List<String>? = null,
    @SerialName("excludeKeywords") val `excludeKeywords`: List<String>? = null,
    @SerialName("ignoreShorts") val `ignoreShorts`: Boolean,
    @SerialName("lastCheckedAt") val `lastCheckedAt`: String? = null,
    @SerialName("lastVideoId") val `lastVideoId`: String? = null,
    @SerialName("downloadCount") val `downloadCount`: Double? = null
)

@Serializable
data class YouTubeSubscriptionsResponse(
    @SerialName("subscriptions") val `subscriptions`: List<YouTubeSubscription>
)

@Serializable
data class YouTubeDownloadItem(
    @SerialName("videoId") val `videoId`: String,
    @SerialName("channelId") val `channelId`: String? = null,
    @SerialName("channelTitle") val `channelTitle`: String? = null,
    @SerialName("title") val `title`: String,
    @SerialName("durationSeconds") val `durationSeconds`: Double? = null,
    @SerialName("thumbnailUrl") val `thumbnailUrl`: String? = null,
    @SerialName("uploadDate") val `uploadDate`: String? = null,
    @SerialName("status") val `status`: String,
    @SerialName("progressPercent") val `progressPercent`: Double,
    @SerialName("speedBytes") val `speedBytes`: Double,
    @SerialName("etaSeconds") val `etaSeconds`: Double? = null,
    @SerialName("filePath") val `filePath`: String? = null,
    @SerialName("errorMessage") val `errorMessage`: String? = null,
    @SerialName("createdAt") val `createdAt`: String,
    @SerialName("completedAt") val `completedAt`: String? = null
)

@Serializable
data class YouTubeQueueResponse(
    @SerialName("queue") val `queue`: List<YouTubeDownloadItem>
)

@Serializable
data class YouTubeArchiveItem(
    @SerialName("id") val `id`: String,
    @SerialName("title") val `title`: String,
    @SerialName("channelName") val `channelName`: String,
    @SerialName("filePath") val `filePath`: String,
    @SerialName("fileSize") val `fileSize`: Double,
    @SerialName("thumbnailUrl") val `thumbnailUrl`: String? = null,
    @SerialName("modifiedAt") val `modifiedAt`: String,
    @SerialName("streamUrl") val `streamUrl`: String
)

@Serializable
data class YouTubeArchiveResponse(
    @SerialName("items") val `items`: List<YouTubeArchiveItem>
)

@Serializable
data class WebGetAuthQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("action") val `action`: String? = null
)

@Serializable
data class WebGetAuthResponse(
    @SerialName("requiresAuth") val `requiresAuth`: Boolean? = null,
    @SerialName("isAuthenticated") val `isAuthenticated`: Boolean? = null,
    @SerialName("isLocalOrTailscale") val `isLocalOrTailscale`: Boolean? = null,
    @SerialName("canManageIntegrations") val `canManageIntegrations`: Boolean? = null,
    @SerialName("users") val `users`: List<WebGetAuthResponseUsersItem>? = null
)

@Serializable
data class WebGetAuthResponseUsersItem(
    @SerialName("id") val `id`: String? = null,
    @SerialName("name") val `name`: String? = null,
    @SerialName("isKids") val `isKids`: Boolean? = null,
    @SerialName("kidsRating") val `kidsRating`: String? = null
)

@Serializable
data class WebPostAuthQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostAuthBody(
    @SerialName("username") val `username`: String? = null,
    @SerialName("password") val `password`: String? = null,
    @SerialName("action") val `action`: String? = null
)

@Serializable
data class WebPostAuthResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebGetConfigQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostConfigQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("action") val `action`: String? = null
)

@Serializable
data class WebPostConfigBody(
    @SerialName("appName") val `appName`: String? = null,
    @SerialName("jellyfinUrl") val `jellyfinUrl`: String? = null,
    @SerialName("jellyfinApiKey") val `jellyfinApiKey`: String? = null,
    @SerialName("jellyfinUserId") val `jellyfinUserId`: String? = null,
    @SerialName("seerrUrl") val `seerrUrl`: String? = null,
    @SerialName("seerrApiKey") val `seerrApiKey`: String? = null,
    @SerialName("qbittorrentUrl") val `qbittorrentUrl`: String? = null,
    @SerialName("qbittorrentUsername") val `qbittorrentUsername`: String? = null,
    @SerialName("qbittorrentPassword") val `qbittorrentPassword`: String? = null,
    @SerialName("downloadsPath") val `downloadsPath`: String? = null,
    @SerialName("radarrUrl") val `radarrUrl`: String? = null,
    @SerialName("radarrApiKey") val `radarrApiKey`: String? = null,
    @SerialName("sonarrUrl") val `sonarrUrl`: String? = null,
    @SerialName("sonarrApiKey") val `sonarrApiKey`: String? = null,
    @SerialName("tmdbApiKey") val `tmdbApiKey`: String? = null,
    @SerialName("url") val `url`: String? = null,
    @SerialName("apiKey") val `apiKey`: String? = null,
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("username") val `username`: String? = null,
    @SerialName("password") val `password`: String? = null,
    @SerialName("parentPin") val `parentPin`: String? = null,
    @SerialName("action") val `action`: String? = null
)

@Serializable
data class WebPostConfigResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("config") val `config`: JsonElement? = null,
    @SerialName("error") val `error`: String? = null
)

@Serializable
data class WebGetHomeQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebGetLibraryTypeQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("search") val `search`: String? = null,
    @SerialName("letter") val `letter`: String? = null
)

@Serializable
data class WebGetCategoriesTypeQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebGetCategoriesTypeResponse(
    @SerialName("type") val `type`: String? = null,
    @SerialName("sections") val `sections`: List<JsonElement>? = null
)

@Serializable
data class WebGetMediaIdQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("type") val `type`: String? = null
)

@Serializable
data class WebGetMediaIdRecommendationsQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("tmdbId") val `tmdbId`: String? = null,
    @SerialName("type") val `type`: String? = null
)

@Serializable
data class WebGetMediaIdRecommendationsResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("source") val `source`: String? = null,
    @SerialName("recommendations") val `recommendations`: List<WebGetMediaIdRecommendationsResponseRecommendationsItem>? = null
)

@Serializable
data class WebGetMediaIdRecommendationsResponseRecommendationsItem(
    @SerialName("id") val `id`: String? = null,
    @SerialName("title") val `title`: String? = null,
    @SerialName("type") val `type`: String? = null
)

@Serializable
data class WebGetProfilesQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("includeAvailable") val `includeAvailable`: String? = null
)

@Serializable
data class WebPostProfilesQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostProfilesBody(
    @SerialName("action") val `action`: String? = null,
    @SerialName("profileId") val `profileId`: String? = null,
    @SerialName("name") val `name`: String? = null,
    @SerialName("userIds") val `userIds`: List<String>? = null,
    @SerialName("jellyfinUserIds") val `jellyfinUserIds`: List<String>? = null,
    @SerialName("jellyfinUserId") val `jellyfinUserId`: String? = null,
    @SerialName("paletteIndex") val `paletteIndex`: Long? = null,
    @SerialName("avatarId") val `avatarId`: String? = null,
    @SerialName("mode") val `mode`: String? = null,
    @SerialName("password") val `password`: String? = null,
    @SerialName("isKids") val `isKids`: Boolean? = null,
    @SerialName("kidsDateOfBirth") val `kidsDateOfBirth`: String? = null,
    @SerialName("parentPin") val `parentPin`: String? = null
)

@Serializable
data class WebPostProfilesResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("profiles") val `profiles`: List<WebPostProfilesResponseProfilesItem>? = null,
    @SerialName("profile") val `profile`: WebPostProfilesResponseProfile? = null
)

@Serializable
data class WebPostProfilesResponseProfilesItem(
    @SerialName("id") val `id`: String? = null,
    @SerialName("name") val `name`: String? = null,
    @SerialName("isKids") val `isKids`: Boolean? = null,
    @SerialName("kidsRating") val `kidsRating`: String? = null
)

@Serializable
data class WebPostProfilesResponseProfile(
    @SerialName("id") val `id`: String? = null,
    @SerialName("name") val `name`: String? = null,
    @SerialName("isKids") val `isKids`: Boolean? = null,
    @SerialName("kidsRating") val `kidsRating`: String? = null
)

@Serializable
data class WebGetSearchQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("q") val `q`: String? = null
)

@Serializable
data class WebGetSearchResponse(
    @SerialName("results") val `results`: List<WebGetSearchResponseResultsItem>? = null,
    @SerialName("isDemoMode") val `isDemoMode`: Boolean? = null
)

@Serializable
data class WebGetSearchResponseResultsItem(
    @SerialName("id") val `id`: String? = null,
    @SerialName("title") val `title`: String? = null,
    @SerialName("type") val `type`: String? = null
)

@Serializable
data class WebGetDownloadsQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebGetDownloadsResponse(
    @SerialName("items") val `items`: List<JsonElement>? = null
)

@Serializable
data class WebGetPlaybackQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("itemId") val `itemId`: String,
    @SerialName("startTimeTicks") val `startTimeTicks`: String? = null,
    @SerialName("forceTranscode") val `forceTranscode`: String? = null,
    @SerialName("canPlayHevc") val `canPlayHevc`: String? = null,
    @SerialName("receiver") val `receiver`: String? = null,
    @SerialName("videoCodecs") val `videoCodecs`: String? = null,
    @SerialName("audioCodecs") val `audioCodecs`: String? = null,
    @SerialName("videoCapabilities") val `videoCapabilities`: String? = null,
    @SerialName("maxWidth") val `maxWidth`: String? = null,
    @SerialName("maxHeight") val `maxHeight`: String? = null
)

@Serializable
data class WebPostPlaybackProgressQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostPlaybackProgressBody(
    @SerialName("itemId") val `itemId`: String,
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("positionTicks") val `positionTicks`: Long,
    @SerialName("isPaused") val `isPaused`: Boolean? = null,
    @SerialName("isStopped") val `isStopped`: Boolean? = null,
    @SerialName("isStarted") val `isStarted`: Boolean? = null
)

@Serializable
data class WebPostPlaybackProgressResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebGetRequestQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("type") val `type`: String? = null
)

@Serializable
data class WebGetRequestResponse(
    @SerialName("profiles") val `profiles`: List<JsonElement>? = null,
    @SerialName("defaultProfileId") val `defaultProfileId`: Long? = null
)

@Serializable
data class WebPostRequestQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostRequestBody(
    @SerialName("mediaType") val `mediaType`: String,
    @SerialName("mediaId") val `mediaId`: Long,
    @SerialName("seasons") val `seasons`: JsonElement? = null,
    @SerialName("is4k") val `is4k`: Boolean? = null,
    @SerialName("profileId") val `profileId`: Long? = null,
    @SerialName("serverId") val `serverId`: Long? = null
)

@Serializable
data class WebPostRequestResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebGetPreviewStreamQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("itemId") val `itemId`: String,
    @SerialName("ticks") val `ticks`: String? = null
)

@Serializable
data class WebGetSubtitlesQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("itemId") val `itemId`: String,
    @SerialName("mediaSourceId") val `mediaSourceId`: String? = null,
    @SerialName("index") val `index`: String? = null
)

@Serializable
data class WebGetSubtitlesResponse(
    @SerialName("subtitles") val `subtitles`: List<JsonElement>? = null
)

@Serializable
data class WebGetTrailerQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("itemId") val `itemId`: String? = null,
    @SerialName("tmdbId") val `tmdbId`: String? = null,
    @SerialName("type") val `type`: String? = null
)

@Serializable
data class WebGetTrailerResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("trailer") val `trailer`: JsonElement? = null
)

@Serializable
data class WebGetStreamDownloadQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("hash") val `hash`: String? = null,
    @SerialName("path") val `path`: String? = null,
    @SerialName("fileIndex") val `fileIndex`: String? = null,
    @SerialName("season") val `season`: String? = null,
    @SerialName("episode") val `episode`: String? = null,
    @SerialName("start") val `start`: String? = null,
    @SerialName("transcode") val `transcode`: String? = null,
    @SerialName("native") val `native`: String? = null,
    @SerialName("source") val `source`: String? = null,
    @SerialName("probe") val `probe`: String? = null,
    @SerialName("growing") val `growing`: String? = null
)

@Serializable
data class WebGetStreamTorrentQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("tmdbId") val `tmdbId`: String? = null,
    @SerialName("type") val `type`: String? = null,
    @SerialName("season") val `season`: String? = null,
    @SerialName("episode") val `episode`: String? = null,
    @SerialName("title") val `title`: String? = null,
    @SerialName("magnet") val `magnet`: String? = null,
    @SerialName("forceTranscode") val `forceTranscode`: String? = null,
    @SerialName("canPlayHevc") val `canPlayHevc`: String? = null,
    @SerialName("receiver") val `receiver`: String? = null
)

@Serializable
data class WebGetWebhookArrQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebGetWebhookArrResponse(
    @SerialName("status") val `status`: String? = null
)

@Serializable
data class WebPostWebhookArrQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostWebhookArrBody(
    @SerialName("eventType") val `eventType`: String? = null,
    @SerialName("downloadId") val `downloadId`: String? = null,
    @SerialName("torrentHash") val `torrentHash`: String? = null,
    @SerialName("event_type") val `event_type`: String? = null
)

@Serializable
data class WebPostWebhookArrResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebGetCatalogLinksQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebGetCatalogLinksResponse(
    @SerialName("items") val `items`: List<WebGetCatalogLinksResponseItemsItem>? = null
)

@Serializable
data class WebGetCatalogLinksResponseItemsItem(
    @SerialName("id") val `id`: String? = null,
    @SerialName("title") val `title`: String? = null,
    @SerialName("type") val `type`: String? = null
)

@Serializable
data class WebGetMusicQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("q") val `q`: String? = null,
    @SerialName("offset") val `offset`: String? = null
)

@Serializable
data class WebGetMusicAlbumQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("albumId") val `albumId`: String
)

@Serializable
data class WebDeleteMusicAlbumQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("albumId") val `albumId`: String? = null
)

@Serializable
data class WebDeleteMusicAlbumResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebGetMusicArtworkQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("albumId") val `albumId`: String
)

@Serializable
data class WebGetMusicStreamQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("trackId") val `trackId`: String
)

@Serializable
data class WebPostMusicRequestQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostMusicRequestBody(
    @SerialName("musicbrainzId") val `musicbrainzId`: String? = null,
    @SerialName("albumId") val `albumId`: String? = null
)

@Serializable
data class WebPostMusicRequestResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebPostMusicProfileAlbumQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostMusicProfileAlbumBody(
    @SerialName("albumId") val `albumId`: String? = null
)

@Serializable
data class WebPostMusicProfileAlbumResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebDeleteMusicProfileAlbumQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("albumId") val `albumId`: String? = null
)

@Serializable
data class WebDeleteMusicProfileAlbumResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebGetMusicPlaylistsQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("profileId") val `profileId`: String? = null
)

@Serializable
data class WebPostMusicPlaylistsQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostMusicPlaylistsBody(
    @SerialName("name") val `name`: String,
    @SerialName("description") val `description`: String? = null
)

@Serializable
data class WebPostMusicPlaylistsResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("playlist") val `playlist`: JsonElement? = null
)

@Serializable
data class WebPostMusicPlaylistsImportQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostMusicPlaylistsImportBody(
    @SerialName("url") val `url`: String? = null,
    @SerialName("urls") val `urls`: JsonElement? = null,
    @SerialName("spotifyUrl") val `spotifyUrl`: String? = null,
    @SerialName("csv") val `csv`: String? = null,
    @SerialName("files") val `files`: List<WebPostMusicPlaylistsImportBodyFilesItem>? = null,
    @SerialName("zipBase64") val `zipBase64`: String? = null,
    @SerialName("playlistName") val `playlistName`: String? = null
)

@Serializable
data class WebPostMusicPlaylistsImportBodyFilesItem(
    @SerialName("name") val `name`: String? = null,
    @SerialName("content") val `content`: String? = null
)

@Serializable
data class WebPostMusicPlaylistsImportResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null,
    @SerialName("playlists") val `playlists`: List<JsonElement>? = null,
    @SerialName("totalTracksQueued") val `totalTracksQueued`: Long? = null
)

@Serializable
data class WebPostMusicPlaylistsImportSpotifyQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostMusicPlaylistsImportSpotifyBody(
    @SerialName("url") val `url`: String? = null,
    @SerialName("urls") val `urls`: JsonElement? = null,
    @SerialName("spotifyUrl") val `spotifyUrl`: String? = null
)

@Serializable
data class WebPostMusicPlaylistsImportSpotifyResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null,
    @SerialName("playlists") val `playlists`: List<JsonElement>? = null,
    @SerialName("totalTracksQueued") val `totalTracksQueued`: Long? = null
)

@Serializable
data class WebPostMusicPlaylistsImportExportifyQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostMusicPlaylistsImportExportifyBody(
    @SerialName("csv") val `csv`: String? = null,
    @SerialName("files") val `files`: List<WebPostMusicPlaylistsImportExportifyBodyFilesItem>? = null,
    @SerialName("zipBase64") val `zipBase64`: String? = null,
    @SerialName("playlistName") val `playlistName`: String? = null
)

@Serializable
data class WebPostMusicPlaylistsImportExportifyBodyFilesItem(
    @SerialName("name") val `name`: String? = null,
    @SerialName("content") val `content`: String? = null
)

@Serializable
data class WebPostMusicPlaylistsImportExportifyResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null,
    @SerialName("playlists") val `playlists`: List<JsonElement>? = null,
    @SerialName("totalTracksQueued") val `totalTracksQueued`: Long? = null
)

@Serializable
data class WebGetMusicPlaylistQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("playlistId") val `playlistId`: String? = null
)

@Serializable
data class WebDeleteMusicPlaylistQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("playlistId") val `playlistId`: String? = null
)

@Serializable
data class WebDeleteMusicPlaylistResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebPostMusicPlaylistTrackQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostMusicPlaylistTrackBody(
    @SerialName("playlistId") val `playlistId`: String,
    @SerialName("trackId") val `trackId`: String
)

@Serializable
data class WebPostMusicPlaylistTrackResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebDeleteMusicPlaylistTrackQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("playlistId") val `playlistId`: String? = null,
    @SerialName("trackId") val `trackId`: String? = null
)

@Serializable
data class WebDeleteMusicPlaylistTrackResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebGetRequestedQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebGetIntegrationsQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostIntegrationsQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostIntegrationsBody(
    @SerialName("integration") val `integration`: String,
    @SerialName("action") val `action`: String,
    @SerialName("url") val `url`: String? = null,
    @SerialName("secret") val `secret`: String? = null,
    @SerialName("username") val `username`: String? = null,
    @SerialName("downloadsPath") val `downloadsPath`: String? = null,
    @SerialName("parentPin") val `parentPin`: String? = null
)

@Serializable
data class WebGetYoutubeSearchQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("q") val `q`: String? = null
)

@Serializable
data class WebGetYoutubeStreamQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("videoId") val `videoId`: String
)

@Serializable
data class WebGetYoutubeStreamVideoQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("videoId") val `videoId`: String
)

@Serializable
data class WebPostYoutubeProgressQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostYoutubeProgressBody(
    @SerialName("videoId") val `videoId`: String,
    @SerialName("positionSeconds") val `positionSeconds`: Long? = null,
    @SerialName("durationSeconds") val `durationSeconds`: Long? = null,
    @SerialName("completed") val `completed`: Boolean? = null,
    @SerialName("title") val `title`: String? = null,
    @SerialName("channelTitle") val `channelTitle`: String? = null,
    @SerialName("thumbnailUrl") val `thumbnailUrl`: String? = null
)

@Serializable
data class WebPostYoutubeProgressResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebGetYoutubeContinueWatchingQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebGetYoutubeContinueWatchingResponse(
    @SerialName("items") val `items`: List<JsonElement>? = null
)

@Serializable
data class WebDeleteYoutubeContinueWatchingQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("videoId") val `videoId`: String
)

@Serializable
data class WebDeleteYoutubeContinueWatchingResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebGetYoutubeAuthQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebGetYoutubeAuthResponse(
    @SerialName("authenticated") val `authenticated`: Boolean? = null
)

@Serializable
data class WebPostYoutubeAuthQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostYoutubeAuthBody(
    @SerialName("cookiesText") val `cookiesText`: String? = null
)

@Serializable
data class WebPostYoutubeAuthResponse(
    @SerialName("success") val `success`: Boolean? = null
)

@Serializable
data class WebDeleteYoutubeAuthQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebDeleteYoutubeAuthResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebGetYoutubeRecommendationsQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebGetYoutubeRecommendationsResponse(
    @SerialName("hero") val `hero`: JsonElement? = null,
    @SerialName("sections") val `sections`: List<JsonElement>? = null
)

@Serializable
data class WebPostYoutubeDownloadQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostYoutubeDownloadBody(
    @SerialName("videoId") val `videoId`: String,
    @SerialName("channelId") val `channelId`: String? = null,
    @SerialName("channelTitle") val `channelTitle`: String? = null,
    @SerialName("title") val `title`: String,
    @SerialName("durationSeconds") val `durationSeconds`: Long? = null,
    @SerialName("thumbnailUrl") val `thumbnailUrl`: String? = null,
    @SerialName("uploadDate") val `uploadDate`: String? = null
)

@Serializable
data class WebPostYoutubeDownloadResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebGetYoutubeSubscriptionsQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostYoutubeSubscriptionsQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostYoutubeSubscriptionsBody(
    @SerialName("channelUrlOrHandle") val `channelUrlOrHandle`: String,
    @SerialName("autoDownload") val `autoDownload`: Boolean? = null,
    @SerialName("minDurationSeconds") val `minDurationSeconds`: Long? = null,
    @SerialName("maxDurationSeconds") val `maxDurationSeconds`: Long? = null,
    @SerialName("includeKeywords") val `includeKeywords`: List<String>? = null,
    @SerialName("excludeKeywords") val `excludeKeywords`: List<String>? = null,
    @SerialName("ignoreShorts") val `ignoreShorts`: Boolean? = null
)

@Serializable
data class WebPostYoutubeSubscriptionsResponse(
    @SerialName("success") val `success`: Boolean? = null
)

@Serializable
data class WebPutYoutubeSubscriptionsQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPutYoutubeSubscriptionsBody(
    @SerialName("id") val `id`: String,
    @SerialName("autoDownload") val `autoDownload`: Boolean? = null,
    @SerialName("minDurationSeconds") val `minDurationSeconds`: Long? = null,
    @SerialName("maxDurationSeconds") val `maxDurationSeconds`: Long? = null,
    @SerialName("includeKeywords") val `includeKeywords`: List<String>? = null,
    @SerialName("excludeKeywords") val `excludeKeywords`: List<String>? = null,
    @SerialName("ignoreShorts") val `ignoreShorts`: Boolean? = null
)

@Serializable
data class WebPutYoutubeSubscriptionsResponse(
    @SerialName("success") val `success`: Boolean? = null
)

@Serializable
data class WebDeleteYoutubeSubscriptionsQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("id") val `id`: String
)

@Serializable
data class WebDeleteYoutubeSubscriptionsResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebPostYoutubeSubscriptionsCheckQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebPostYoutubeSubscriptionsCheckBody(
    @SerialName("channelId") val `channelId`: String? = null
)

@Serializable
data class WebPostYoutubeSubscriptionsCheckResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("downloadedCount") val `downloadedCount`: Long? = null
)

@Serializable
data class WebGetYoutubeQueueQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebDeleteYoutubeQueueQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("videoId") val `videoId`: String
)

@Serializable
data class WebDeleteYoutubeQueueResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class WebGetYoutubeArchiveQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class WebGetYoutubeStreamLocalQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("path") val `path`: String
)

@Serializable
data class WebGetYoutubeThumbnailQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("path") val `path`: String
)

@Serializable
data class MobileGetHomeQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetLibraryTypeQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("search") val `search`: String? = null,
    @SerialName("letter") val `letter`: String? = null
)

@Serializable
data class MobileGetCategoriesTypeQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetCategoriesTypeResponse(
    @SerialName("type") val `type`: String? = null,
    @SerialName("sections") val `sections`: List<JsonElement>? = null
)

@Serializable
data class MobileGetMediaIdQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("type") val `type`: String? = null
)

@Serializable
data class MobileGetMediaIdRecommendationsQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("tmdbId") val `tmdbId`: String? = null,
    @SerialName("type") val `type`: String? = null
)

@Serializable
data class MobileGetMediaIdRecommendationsResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("source") val `source`: String? = null,
    @SerialName("recommendations") val `recommendations`: List<MobileGetMediaIdRecommendationsResponseRecommendationsItem>? = null
)

@Serializable
data class MobileGetMediaIdRecommendationsResponseRecommendationsItem(
    @SerialName("id") val `id`: String? = null,
    @SerialName("title") val `title`: String? = null,
    @SerialName("type") val `type`: String? = null
)

@Serializable
data class MobileGetSearchQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("q") val `q`: String? = null
)

@Serializable
data class MobileGetSearchResponse(
    @SerialName("results") val `results`: List<MobileGetSearchResponseResultsItem>? = null,
    @SerialName("isDemoMode") val `isDemoMode`: Boolean? = null
)

@Serializable
data class MobileGetSearchResponseResultsItem(
    @SerialName("id") val `id`: String? = null,
    @SerialName("title") val `title`: String? = null,
    @SerialName("type") val `type`: String? = null
)

@Serializable
data class MobileGetDownloadsQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetDownloadsResponse(
    @SerialName("items") val `items`: List<JsonElement>? = null
)

@Serializable
data class MobileGetPlaybackQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("itemId") val `itemId`: String,
    @SerialName("startTimeTicks") val `startTimeTicks`: String? = null,
    @SerialName("forceTranscode") val `forceTranscode`: String? = null,
    @SerialName("canPlayHevc") val `canPlayHevc`: String? = null,
    @SerialName("receiver") val `receiver`: String? = null,
    @SerialName("videoCodecs") val `videoCodecs`: String? = null,
    @SerialName("audioCodecs") val `audioCodecs`: String? = null,
    @SerialName("videoCapabilities") val `videoCapabilities`: String? = null,
    @SerialName("maxWidth") val `maxWidth`: String? = null,
    @SerialName("maxHeight") val `maxHeight`: String? = null
)

@Serializable
data class MobileGetRequestQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("type") val `type`: String? = null
)

@Serializable
data class MobileGetRequestResponse(
    @SerialName("profiles") val `profiles`: List<JsonElement>? = null,
    @SerialName("defaultProfileId") val `defaultProfileId`: Long? = null
)

@Serializable
data class MobilePostRequestQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostRequestBody(
    @SerialName("mediaType") val `mediaType`: String,
    @SerialName("mediaId") val `mediaId`: Long,
    @SerialName("seasons") val `seasons`: JsonElement? = null,
    @SerialName("is4k") val `is4k`: Boolean? = null,
    @SerialName("profileId") val `profileId`: Long? = null,
    @SerialName("serverId") val `serverId`: Long? = null
)

@Serializable
data class MobilePostRequestResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class MobileGetSubtitlesQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("itemId") val `itemId`: String,
    @SerialName("mediaSourceId") val `mediaSourceId`: String? = null,
    @SerialName("index") val `index`: String? = null
)

@Serializable
data class MobileGetSubtitlesResponse(
    @SerialName("subtitles") val `subtitles`: List<JsonElement>? = null
)

@Serializable
data class MobileGetTrailerQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("itemId") val `itemId`: String? = null,
    @SerialName("tmdbId") val `tmdbId`: String? = null,
    @SerialName("type") val `type`: String? = null
)

@Serializable
data class MobileGetTrailerResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("trailer") val `trailer`: JsonElement? = null
)

@Serializable
data class MobileGetStreamDownloadQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("hash") val `hash`: String? = null,
    @SerialName("path") val `path`: String? = null,
    @SerialName("fileIndex") val `fileIndex`: String? = null,
    @SerialName("season") val `season`: String? = null,
    @SerialName("episode") val `episode`: String? = null,
    @SerialName("start") val `start`: String? = null,
    @SerialName("transcode") val `transcode`: String? = null,
    @SerialName("native") val `native`: String? = null,
    @SerialName("source") val `source`: String? = null,
    @SerialName("probe") val `probe`: String? = null,
    @SerialName("growing") val `growing`: String? = null
)

@Serializable
data class MobileGetStreamTorrentQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("tmdbId") val `tmdbId`: String? = null,
    @SerialName("type") val `type`: String? = null,
    @SerialName("season") val `season`: String? = null,
    @SerialName("episode") val `episode`: String? = null,
    @SerialName("title") val `title`: String? = null,
    @SerialName("magnet") val `magnet`: String? = null,
    @SerialName("forceTranscode") val `forceTranscode`: String? = null,
    @SerialName("canPlayHevc") val `canPlayHevc`: String? = null,
    @SerialName("receiver") val `receiver`: String? = null
)

@Serializable
data class MobileGetMusicQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("q") val `q`: String? = null,
    @SerialName("offset") val `offset`: String? = null
)

@Serializable
data class MobileGetMusicAlbumQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("albumId") val `albumId`: String
)

@Serializable
data class MobileDeleteMusicAlbumQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("albumId") val `albumId`: String? = null
)

@Serializable
data class MobileDeleteMusicAlbumResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class MobileGetMusicArtworkQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("albumId") val `albumId`: String
)

@Serializable
data class MobileGetMusicStreamQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("trackId") val `trackId`: String
)

@Serializable
data class MobilePostMusicRequestQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostMusicRequestBody(
    @SerialName("musicbrainzId") val `musicbrainzId`: String? = null,
    @SerialName("albumId") val `albumId`: String? = null
)

@Serializable
data class MobilePostMusicRequestResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class MobilePostMusicProfileAlbumQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostMusicProfileAlbumBody(
    @SerialName("albumId") val `albumId`: String? = null
)

@Serializable
data class MobilePostMusicProfileAlbumResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class MobileDeleteMusicProfileAlbumQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("albumId") val `albumId`: String? = null
)

@Serializable
data class MobileDeleteMusicProfileAlbumResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class MobileGetMusicPlaylistsQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("profileId") val `profileId`: String? = null
)

@Serializable
data class MobilePostMusicPlaylistsQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostMusicPlaylistsBody(
    @SerialName("name") val `name`: String,
    @SerialName("description") val `description`: String? = null
)

@Serializable
data class MobilePostMusicPlaylistsResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("playlist") val `playlist`: JsonElement? = null
)

@Serializable
data class MobilePostMusicPlaylistsImportQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostMusicPlaylistsImportBody(
    @SerialName("url") val `url`: String? = null,
    @SerialName("urls") val `urls`: JsonElement? = null,
    @SerialName("spotifyUrl") val `spotifyUrl`: String? = null,
    @SerialName("csv") val `csv`: String? = null,
    @SerialName("files") val `files`: List<MobilePostMusicPlaylistsImportBodyFilesItem>? = null,
    @SerialName("zipBase64") val `zipBase64`: String? = null,
    @SerialName("playlistName") val `playlistName`: String? = null
)

@Serializable
data class MobilePostMusicPlaylistsImportBodyFilesItem(
    @SerialName("name") val `name`: String? = null,
    @SerialName("content") val `content`: String? = null
)

@Serializable
data class MobilePostMusicPlaylistsImportResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null,
    @SerialName("playlists") val `playlists`: List<JsonElement>? = null,
    @SerialName("totalTracksQueued") val `totalTracksQueued`: Long? = null
)

@Serializable
data class MobilePostMusicPlaylistsImportSpotifyQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostMusicPlaylistsImportSpotifyBody(
    @SerialName("url") val `url`: String? = null,
    @SerialName("urls") val `urls`: JsonElement? = null,
    @SerialName("spotifyUrl") val `spotifyUrl`: String? = null
)

@Serializable
data class MobilePostMusicPlaylistsImportSpotifyResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null,
    @SerialName("playlists") val `playlists`: List<JsonElement>? = null,
    @SerialName("totalTracksQueued") val `totalTracksQueued`: Long? = null
)

@Serializable
data class MobilePostMusicPlaylistsImportExportifyQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostMusicPlaylistsImportExportifyBody(
    @SerialName("csv") val `csv`: String? = null,
    @SerialName("files") val `files`: List<MobilePostMusicPlaylistsImportExportifyBodyFilesItem>? = null,
    @SerialName("zipBase64") val `zipBase64`: String? = null,
    @SerialName("playlistName") val `playlistName`: String? = null
)

@Serializable
data class MobilePostMusicPlaylistsImportExportifyBodyFilesItem(
    @SerialName("name") val `name`: String? = null,
    @SerialName("content") val `content`: String? = null
)

@Serializable
data class MobilePostMusicPlaylistsImportExportifyResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null,
    @SerialName("playlists") val `playlists`: List<JsonElement>? = null,
    @SerialName("totalTracksQueued") val `totalTracksQueued`: Long? = null
)

@Serializable
data class MobileGetMusicPlaylistQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("playlistId") val `playlistId`: String? = null
)

@Serializable
data class MobileDeleteMusicPlaylistQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("playlistId") val `playlistId`: String? = null
)

@Serializable
data class MobileDeleteMusicPlaylistResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class MobilePostMusicPlaylistTrackQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostMusicPlaylistTrackBody(
    @SerialName("playlistId") val `playlistId`: String,
    @SerialName("trackId") val `trackId`: String
)

@Serializable
data class MobilePostMusicPlaylistTrackResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class MobileDeleteMusicPlaylistTrackQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("playlistId") val `playlistId`: String? = null,
    @SerialName("trackId") val `trackId`: String? = null
)

@Serializable
data class MobileDeleteMusicPlaylistTrackResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class MobileGetRequestedQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetIntegrationsQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostIntegrationsQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostIntegrationsBody(
    @SerialName("integration") val `integration`: String,
    @SerialName("action") val `action`: String,
    @SerialName("url") val `url`: String? = null,
    @SerialName("secret") val `secret`: String? = null,
    @SerialName("username") val `username`: String? = null,
    @SerialName("downloadsPath") val `downloadsPath`: String? = null,
    @SerialName("parentPin") val `parentPin`: String? = null
)

@Serializable
data class MobileGetYoutubeSearchQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("q") val `q`: String? = null
)

@Serializable
data class MobileGetYoutubeStreamQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("videoId") val `videoId`: String
)

@Serializable
data class MobileGetYoutubeStreamVideoQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("videoId") val `videoId`: String
)

@Serializable
data class MobilePostYoutubeProgressQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostYoutubeProgressBody(
    @SerialName("videoId") val `videoId`: String,
    @SerialName("positionSeconds") val `positionSeconds`: Long? = null,
    @SerialName("durationSeconds") val `durationSeconds`: Long? = null,
    @SerialName("completed") val `completed`: Boolean? = null,
    @SerialName("title") val `title`: String? = null,
    @SerialName("channelTitle") val `channelTitle`: String? = null,
    @SerialName("thumbnailUrl") val `thumbnailUrl`: String? = null
)

@Serializable
data class MobilePostYoutubeProgressResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class MobileGetYoutubeContinueWatchingQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetYoutubeContinueWatchingResponse(
    @SerialName("items") val `items`: List<JsonElement>? = null
)

@Serializable
data class MobileDeleteYoutubeContinueWatchingQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("videoId") val `videoId`: String
)

@Serializable
data class MobileDeleteYoutubeContinueWatchingResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class MobileGetYoutubeAuthQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetYoutubeAuthResponse(
    @SerialName("authenticated") val `authenticated`: Boolean? = null
)

@Serializable
data class MobilePostYoutubeAuthQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostYoutubeAuthBody(
    @SerialName("cookiesText") val `cookiesText`: String? = null
)

@Serializable
data class MobilePostYoutubeAuthResponse(
    @SerialName("success") val `success`: Boolean? = null
)

@Serializable
data class MobileDeleteYoutubeAuthQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileDeleteYoutubeAuthResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class MobileGetYoutubeRecommendationsQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetYoutubeRecommendationsResponse(
    @SerialName("hero") val `hero`: JsonElement? = null,
    @SerialName("sections") val `sections`: List<JsonElement>? = null
)

@Serializable
data class MobilePostYoutubeDownloadQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostYoutubeDownloadBody(
    @SerialName("videoId") val `videoId`: String,
    @SerialName("channelId") val `channelId`: String? = null,
    @SerialName("channelTitle") val `channelTitle`: String? = null,
    @SerialName("title") val `title`: String,
    @SerialName("durationSeconds") val `durationSeconds`: Long? = null,
    @SerialName("thumbnailUrl") val `thumbnailUrl`: String? = null,
    @SerialName("uploadDate") val `uploadDate`: String? = null
)

@Serializable
data class MobilePostYoutubeDownloadResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class MobileGetYoutubeSubscriptionsQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostYoutubeSubscriptionsQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostYoutubeSubscriptionsBody(
    @SerialName("channelUrlOrHandle") val `channelUrlOrHandle`: String,
    @SerialName("autoDownload") val `autoDownload`: Boolean? = null,
    @SerialName("minDurationSeconds") val `minDurationSeconds`: Long? = null,
    @SerialName("maxDurationSeconds") val `maxDurationSeconds`: Long? = null,
    @SerialName("includeKeywords") val `includeKeywords`: List<String>? = null,
    @SerialName("excludeKeywords") val `excludeKeywords`: List<String>? = null,
    @SerialName("ignoreShorts") val `ignoreShorts`: Boolean? = null
)

@Serializable
data class MobilePostYoutubeSubscriptionsResponse(
    @SerialName("success") val `success`: Boolean? = null
)

@Serializable
data class MobilePutYoutubeSubscriptionsQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePutYoutubeSubscriptionsBody(
    @SerialName("id") val `id`: String,
    @SerialName("autoDownload") val `autoDownload`: Boolean? = null,
    @SerialName("minDurationSeconds") val `minDurationSeconds`: Long? = null,
    @SerialName("maxDurationSeconds") val `maxDurationSeconds`: Long? = null,
    @SerialName("includeKeywords") val `includeKeywords`: List<String>? = null,
    @SerialName("excludeKeywords") val `excludeKeywords`: List<String>? = null,
    @SerialName("ignoreShorts") val `ignoreShorts`: Boolean? = null
)

@Serializable
data class MobilePutYoutubeSubscriptionsResponse(
    @SerialName("success") val `success`: Boolean? = null
)

@Serializable
data class MobileDeleteYoutubeSubscriptionsQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("id") val `id`: String
)

@Serializable
data class MobileDeleteYoutubeSubscriptionsResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class MobilePostYoutubeSubscriptionsCheckQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostYoutubeSubscriptionsCheckBody(
    @SerialName("channelId") val `channelId`: String? = null
)

@Serializable
data class MobilePostYoutubeSubscriptionsCheckResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("downloadedCount") val `downloadedCount`: Long? = null
)

@Serializable
data class MobileGetYoutubeQueueQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileDeleteYoutubeQueueQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("videoId") val `videoId`: String
)

@Serializable
data class MobileDeleteYoutubeQueueResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class MobileGetYoutubeArchiveQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetYoutubeStreamLocalQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("path") val `path`: String
)

@Serializable
data class MobileGetYoutubeThumbnailQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("path") val `path`: String
)

@Serializable
data class MobileGetDiscoveryQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetDiscoveryResponse(
    @SerialName("apiVersion") val `apiVersion`: Long? = null,
    @SerialName("appName") val `appName`: String? = null,
    @SerialName("cast") val `cast`: Boolean? = null,
    @SerialName("pairing") val `pairing`: String? = null,
    @SerialName("localPairing") val `localPairing`: Boolean? = null,
    @SerialName("jellyfinLogin") val `jellyfinLogin`: Boolean? = null
)

@Serializable
data class MobileGetCapabilitiesQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetAuthUsersQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetAuthUsersResponse(
    @SerialName("users") val `users`: List<MobileGetAuthUsersResponseUsersItem>? = null
)

@Serializable
data class MobileGetAuthUsersResponseUsersItem(
    @SerialName("id") val `id`: String? = null,
    @SerialName("name") val `name`: String? = null,
    @SerialName("isKids") val `isKids`: Boolean? = null,
    @SerialName("kidsRating") val `kidsRating`: String? = null
)

@Serializable
data class MobilePostAuthLoginQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostAuthLoginBody(
    @SerialName("username") val `username`: String,
    @SerialName("password") val `password`: String
)

@Serializable
data class MobilePostAuthLoginResponse(
    @SerialName("user") val `user`: MobilePostAuthLoginResponseUser? = null,
    @SerialName("token") val `token`: String? = null
)

@Serializable
data class MobilePostAuthLoginResponseUser(
    @SerialName("id") val `id`: String? = null,
    @SerialName("name") val `name`: String? = null,
    @SerialName("isKids") val `isKids`: Boolean? = null,
    @SerialName("kidsRating") val `kidsRating`: String? = null
)

@Serializable
data class MobilePostAuthPairQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostAuthPairBody(
    @SerialName("deviceId") val `deviceId`: String,
    @SerialName("deviceName") val `deviceName`: String? = null
)

@Serializable
data class MobilePostAuthPairResponse(
    @SerialName("token") val `token`: String? = null,
    @SerialName("externalUrl") val `externalUrl`: String? = null,
    @SerialName("serverName") val `serverName`: String? = null
)

@Serializable
data class MobileGetProfilesQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetProfilesResponse(
    @SerialName("profiles") val `profiles`: List<MobileGetProfilesResponseProfilesItem>? = null,
    @SerialName("canManage") val `canManage`: Boolean? = null,
    @SerialName("avatars") val `avatars`: List<String>? = null,
    @SerialName("parentPinConfigured") val `parentPinConfigured`: Boolean? = null,
    @SerialName("activeProfileId") val `activeProfileId`: String? = null
)

@Serializable
data class MobileGetProfilesResponseProfilesItem(
    @SerialName("id") val `id`: String? = null,
    @SerialName("name") val `name`: String? = null,
    @SerialName("isKids") val `isKids`: Boolean? = null,
    @SerialName("kidsRating") val `kidsRating`: String? = null
)

@Serializable
data class MobilePostProfilesQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostProfilesBody(
    @SerialName("action") val `action`: String? = null,
    @SerialName("profileId") val `profileId`: String? = null,
    @SerialName("name") val `name`: String? = null,
    @SerialName("userIds") val `userIds`: List<String>? = null,
    @SerialName("jellyfinUserIds") val `jellyfinUserIds`: List<String>? = null,
    @SerialName("jellyfinUserId") val `jellyfinUserId`: String? = null,
    @SerialName("paletteIndex") val `paletteIndex`: Long? = null,
    @SerialName("avatarId") val `avatarId`: String? = null,
    @SerialName("mode") val `mode`: String? = null,
    @SerialName("password") val `password`: String? = null,
    @SerialName("isKids") val `isKids`: Boolean? = null,
    @SerialName("kidsDateOfBirth") val `kidsDateOfBirth`: String? = null,
    @SerialName("parentPin") val `parentPin`: String? = null
)

@Serializable
data class MobilePostProfilesResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("profile") val `profile`: MobilePostProfilesResponseProfile? = null,
    @SerialName("passwordMode") val `passwordMode`: String? = null
)

@Serializable
data class MobilePostProfilesResponseProfile(
    @SerialName("id") val `id`: String? = null,
    @SerialName("name") val `name`: String? = null,
    @SerialName("isKids") val `isKids`: Boolean? = null,
    @SerialName("kidsRating") val `kidsRating`: String? = null
)

@Serializable
data class MobilePostProfilesSelectQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostProfilesSelectBody(
    @SerialName("profileId") val `profileId`: String,
    @SerialName("parentPin") val `parentPin`: String? = null
)

@Serializable
data class MobilePostProfilesSelectResponse(
    @SerialName("profile") val `profile`: MobilePostProfilesSelectResponseProfile? = null,
    @SerialName("revision") val `revision`: String? = null
)

@Serializable
data class MobilePostProfilesSelectResponseProfile(
    @SerialName("id") val `id`: String? = null,
    @SerialName("name") val `name`: String? = null,
    @SerialName("isKids") val `isKids`: Boolean? = null,
    @SerialName("kidsRating") val `kidsRating`: String? = null
)

@Serializable
data class MobileGetProfilesStatusQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetProfilesStatusResponse(
    @SerialName("profile") val `profile`: MobileGetProfilesStatusResponseProfile? = null,
    @SerialName("revision") val `revision`: String? = null,
    @SerialName("parentPinConfigured") val `parentPinConfigured`: Boolean? = null
)

@Serializable
data class MobileGetProfilesStatusResponseProfile(
    @SerialName("id") val `id`: String? = null,
    @SerialName("name") val `name`: String? = null,
    @SerialName("isKids") val `isKids`: Boolean? = null,
    @SerialName("kidsRating") val `kidsRating`: String? = null
)

@Serializable
data class MobileGetSessionStatusQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetSessionStatusResponse(
    @SerialName("profile") val `profile`: MobileGetSessionStatusResponseProfile? = null,
    @SerialName("revision") val `revision`: String? = null,
    @SerialName("parentPinConfigured") val `parentPinConfigured`: Boolean? = null
)

@Serializable
data class MobileGetSessionStatusResponseProfile(
    @SerialName("id") val `id`: String? = null,
    @SerialName("name") val `name`: String? = null,
    @SerialName("isKids") val `isKids`: Boolean? = null,
    @SerialName("kidsRating") val `kidsRating`: String? = null
)

@Serializable
data class MobileGetProfilesUsersQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetProfilesUsersResponse(
    @SerialName("users") val `users`: List<MobileGetProfilesUsersResponseUsersItem>? = null
)

@Serializable
data class MobileGetProfilesUsersResponseUsersItem(
    @SerialName("id") val `id`: String? = null,
    @SerialName("name") val `name`: String? = null,
    @SerialName("isKids") val `isKids`: Boolean? = null,
    @SerialName("kidsRating") val `kidsRating`: String? = null
)

@Serializable
data class MobilePostProfilesUsersQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostProfilesUsersBody(
    @SerialName("parentPin") val `parentPin`: String? = null
)

@Serializable
data class MobilePostProfilesUsersResponse(
    @SerialName("users") val `users`: List<MobilePostProfilesUsersResponseUsersItem>? = null
)

@Serializable
data class MobilePostProfilesUsersResponseUsersItem(
    @SerialName("id") val `id`: String? = null,
    @SerialName("name") val `name`: String? = null,
    @SerialName("isKids") val `isKids`: Boolean? = null,
    @SerialName("kidsRating") val `kidsRating`: String? = null
)

@Serializable
data class MobileGetContinueWatchingQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetContinueWatchingResponse(
    @SerialName("items") val `items`: List<MobileGetContinueWatchingResponseItemsItem>? = null
)

@Serializable
data class MobileGetContinueWatchingResponseItemsItem(
    @SerialName("id") val `id`: String? = null,
    @SerialName("title") val `title`: String? = null,
    @SerialName("type") val `type`: String? = null
)

@Serializable
data class MobileGetEpisodesQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("itemId") val `itemId`: String
)

@Serializable
data class MobileGetEpisodesResponse(
    @SerialName("items") val `items`: List<JsonElement>? = null
)

@Serializable
data class MobilePostWatchedQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostWatchedBody(
    @SerialName("itemId") val `itemId`: String,
    @SerialName("played") val `played`: Boolean,
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostWatchedResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class MobilePostProgressQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobilePostProgressBody(
    @SerialName("itemId") val `itemId`: String,
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("positionTicks") val `positionTicks`: Long,
    @SerialName("isPaused") val `isPaused`: Boolean? = null,
    @SerialName("isStopped") val `isStopped`: Boolean? = null,
    @SerialName("isStarted") val `isStarted`: Boolean? = null
)

@Serializable
data class MobilePostProgressResponse(
    @SerialName("success") val `success`: Boolean? = null,
    @SerialName("message") val `message`: String? = null
)

@Serializable
data class MobileGetMediaIdCollectionQuery(
    @SerialName("userId") val `userId`: String? = null
)

@Serializable
data class MobileGetMediaIdCollectionResponse(
    @SerialName("collection") val `collection`: MobileGetMediaIdCollectionResponseCollection? = null
)

@Serializable
data class MobileGetMediaIdCollectionResponseCollection(
    @SerialName("name") val `name`: String? = null,
    @SerialName("parts") val `parts`: List<MobileGetMediaIdCollectionResponseCollectionPartsItem>? = null
)

@Serializable
data class MobileGetMediaIdCollectionResponseCollectionPartsItem(
    @SerialName("id") val `id`: String? = null,
    @SerialName("title") val `title`: String? = null,
    @SerialName("type") val `type`: String? = null
)

@Serializable
data class MobileGetImageQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("itemId") val `itemId`: String? = null,
    @SerialName("url") val `url`: String? = null,
    @SerialName("type") val `type`: String? = null,
    @SerialName("tag") val `tag`: String? = null,
    @SerialName("maxWidth") val `maxWidth`: String? = null,
    @SerialName("maxHeight") val `maxHeight`: String? = null
)

@Serializable
data class MobileGetParentalResourceQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("ticket") val `ticket`: String
)

@Serializable
data class MobileHeadParentalResourceQuery(
    @SerialName("userId") val `userId`: String? = null,
    @SerialName("ticket") val `ticket`: String
)
