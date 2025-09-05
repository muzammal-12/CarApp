import React from "react";
import { TextInput, StyleSheet, View, Text } from "react-native";

export default function Input({ error, ...props }) {
  return (
    <View style={{ marginBottom: 15 }}>
      <TextInput style={styles.input} {...props} />
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    padding: 12,
    borderRadius: 8,
  },
  error: {
    color: "red",
    fontSize: 12,
    marginTop: 5,
  },
});
