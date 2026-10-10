# Flutter app

The Dart sources and pubspec are included. Generate native Android/iOS runner files once with a locally installed Flutter SDK:

```bash
flutter create --platforms=android,ios .
flutter pub get
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:4000/api
```

`flutter create` generates platform scaffolding; this repository intentionally does not include generated native folders. This is a starter with demo customer and driver views, not yet a full booking engine.
