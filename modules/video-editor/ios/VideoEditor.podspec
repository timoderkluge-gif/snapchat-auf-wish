Pod::Spec.new do |s|
  s.name           = 'VideoEditor'
  s.version        = '1.0.0'
  s.summary        = 'Brennt Textbalken in Videos ein und entfernt auf Wunsch den Ton'
  s.description    = s.summary
  s.license        = 'MIT'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
