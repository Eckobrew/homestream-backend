-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt # core serialization annotations

# kotlinx-serialization-json specific. Add this if you have java.lang.NoClassDefFoundError kotlinx.serialization.json.JsonObjectSerializer
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }

# project specific.
-keep,includedescriptorclasses class uk.eckonet.homestream.api.models.**$$serializer { *; }
-keepclassmembers class uk.eckonet.homestream.api.models.** { *** Companion; }
-keepclasseswithmembers class uk.eckonet.homestream.api.models.** { kotlinx.serialization.KSerializer serializer(...); }
