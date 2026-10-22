# The TurboModule is instantiated reflectively by React Native.
-keep class com.anythingplayer.AnythingPlayerModule { *; }
-keep class com.anythingplayer.AnythingPlayerPackage { *; }
# Named only by a manifest <meta-data> value (Google Cast, `rnapCast=true`), which R8 does not follow.
-keep class com.anythingplayer.cast.RnapCastOptionsProvider { *; }
