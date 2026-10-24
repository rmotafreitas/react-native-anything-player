# The TurboModule is instantiated reflectively by React Native.
-keep class com.anythingplayer.AnythingPlayerModule { *; }
-keep class com.anythingplayer.AnythingPlayerPackage { *; }
-keep class com.anythingplayer.AnythingPlayerSoundModule { *; }
# Named only by a manifest <meta-data> value (Google Cast, `rnapCast=true`), which R8 does not follow.
-keep class com.anythingplayer.cast.RnapCastOptionsProvider { *; }
# Media3's software decoders (`rnapVideoDecoders=true`), created by name when the app has them.
-keep class androidx.media3.decoder.ffmpeg.FfmpegAudioRenderer { public <init>(...); }
-keep class androidx.media3.decoder.vp9.LibvpxVideoRenderer { public <init>(...); }
-keep class androidx.media3.decoder.av1.Libdav1dVideoRenderer { public <init>(...); }
