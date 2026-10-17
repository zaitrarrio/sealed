/* JNI shim between to.sealed.facet.Native (Kotlin) and the Rust decoder's C ABI (sealed_facet.h). */
#include <jni.h>
#include <stdint.h>
#include "sealed_facet.h"

JNIEXPORT jint JNICALL Java_to_sealed_facet_Native_abiVersion(JNIEnv *env, jclass cls) {
  (void)env; (void)cls;
  return (jint)facet_abi_version();
}

JNIEXPORT jlong JNICALL Java_to_sealed_facet_Native_create(JNIEnv *env, jclass cls, jint tiersMask) {
  (void)env; (void)cls;
  return (jlong)(intptr_t)facet_decoder_new((uint32_t)tiersMask);
}

JNIEXPORT void JNICALL Java_to_sealed_facet_Native_destroy(JNIEnv *env, jclass cls, jlong dec) {
  (void)env; (void)cls;
  facet_decoder_free((facet_decoder *)(intptr_t)dec);
}

/* `pixels` is a direct ByteBuffer over the camera frame; returns the number of frames decoded. */
JNIEXPORT jint JNICALL Java_to_sealed_facet_Native_push(JNIEnv *env, jclass cls, jlong dec, jobject pixels, jint width, jint height, jint stride, jint format) {
  (void)cls;
  const uint8_t *p = (const uint8_t *)(*env)->GetDirectBufferAddress(env, pixels);
  jlong cap = (*env)->GetDirectBufferCapacity(env, pixels);
  if (p == NULL || width <= 0 || height <= 0 || stride <= 0 || cap < (jlong)stride * (jlong)height) return 0;
  return (jint)facet_decoder_push_format((facet_decoder *)(intptr_t)dec, p, (uint32_t)width, (uint32_t)height, (uint32_t)stride, (uint32_t)format);
}

JNIEXPORT jbyteArray JNICALL Java_to_sealed_facet_Native_frame(JNIEnv *env, jclass cls, jlong dec, jint i) {
  (void)cls;
  facet_decoder *d = (facet_decoder *)(intptr_t)dec;
  uint32_t len = facet_decoder_frame_len(d, (uint32_t)i);
  jbyteArray out = (*env)->NewByteArray(env, (jsize)len);
  if (out == NULL || len == 0) return out;
  jbyte *buf = (*env)->GetByteArrayElements(env, out, NULL);
  if (buf == NULL) return out;
  facet_decoder_frame_copy(d, (uint32_t)i, (uint8_t *)buf, len);
  (*env)->ReleaseByteArrayElements(env, out, buf, 0);
  return out;
}

JNIEXPORT jfloat JNICALL Java_to_sealed_facet_Native_pixelsPerCell(JNIEnv *env, jclass cls, jlong dec) {
  (void)env; (void)cls;
  return facet_decoder_pixels_per_cell((const facet_decoder *)(intptr_t)dec);
}
