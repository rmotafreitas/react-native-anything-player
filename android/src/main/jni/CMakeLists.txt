# The TurboModule's C++ glue, from the Codegen output, without the iOS-only
# RNAPRoutePickerView component (see react-native.config.js).
cmake_minimum_required(VERSION 3.13)

set(CODEGEN_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../build/generated/source/codegen/jni)

add_library(
  react_codegen_AnythingPlayerSpec
  OBJECT
  ${CODEGEN_DIR}/AnythingPlayerSpec-generated.cpp
)

target_include_directories(react_codegen_AnythingPlayerSpec PUBLIC ${CODEGEN_DIR})

target_link_libraries(
  react_codegen_AnythingPlayerSpec
  fbjni
  jsi
  reactnative
)

target_compile_reactnative_options(react_codegen_AnythingPlayerSpec PRIVATE)
