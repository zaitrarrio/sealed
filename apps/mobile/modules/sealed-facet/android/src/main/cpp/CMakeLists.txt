cmake_minimum_required(VERSION 3.22.1)
project(sealedfacetjni C)

# Prebuilt Rust decoder (cdylib) placed by tools/build-facet-native.sh.
add_library(sealed_facet SHARED IMPORTED)
set_target_properties(sealed_facet PROPERTIES IMPORTED_LOCATION
  ${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libsealed_facet.so)

add_library(sealedfacetjni SHARED jni.c)
target_include_directories(sealedfacetjni PRIVATE ${CMAKE_SOURCE_DIR}/../../../../../../../crates/sealed-facet/include)
target_link_libraries(sealedfacetjni sealed_facet log)
