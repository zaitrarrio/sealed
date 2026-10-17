require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# The Rust decoder, cross-compiled by `task build:facet-ios` into ios/SealedFacet.xcframework (git-ignored).
# Without it the pod builds a stub and the JavaScript side reports the native decoder as unavailable.
has_library = File.directory?(File.join(__dir__, 'SealedFacet.xcframework'))

Pod::Spec.new do |s|
  s.name           = 'SealedFacet'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = 'UNLICENSED'
  s.author         = 'AdvancedAI.ai'
  s.homepage       = 'https://sealed.to'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
  if has_library
    s.vendored_frameworks = 'SealedFacet.xcframework'
    s.pod_target_xcconfig = {
      'DEFINES_MODULE' => 'YES',
      'SWIFT_COMPILATION_MODE' => 'wholemodule',
      'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => 'SEALED_FACET_LIBRARY'
    }
  else
    s.pod_target_xcconfig = {
      'DEFINES_MODULE' => 'YES',
      'SWIFT_COMPILATION_MODE' => 'wholemodule'
    }
  end
end
