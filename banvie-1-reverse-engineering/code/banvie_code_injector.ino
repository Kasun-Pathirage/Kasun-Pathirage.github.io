#include <Arduino.h>
#include <ESP8266WiFi.h>


////////////////////////////////////////////////////////////////////////////
// BANVIE SYSTEM CONTROL VARIABLES
#define banvie_pin D1  // The digital pin that interfaces with the Banvie System

volatile long startTime = 0;  // A timing variable
const int num_positive_pulses = 25; // 25 positive pulse edges because we want 24 pull downs.
const int num_repeats_per_train = 10;  // In case you want to re-issue the same pulse train multiple times (mimicks press and hold)
const int trunk_release_key_press_hold_time_s = 4;  // Mimicks Press and hold this long for trunk release.

const uint16_t period_us = 1500;  // The cycle period per pulse 
const uint16_t long_pulse_length_us = 1200;  // Duration of a HIGH bit
const uint16_t short_pulse_length_us = period_us - long_pulse_length_us;  // Duration of a LOW bit

////////////////////////////////////////////////////////////////////////////
// PULSE TRAINS PER FOB FUNCTION
bool lockPulseWidths[num_positive_pulses] = {1,0,0,1,0,0,1,1,0,0,1,0,1,0,0,0,0,0,0,0,0,0,0,1,0};  // Lock sequence
bool mutedLockPulseWidths[num_positive_pulses] = {1,0,0,1,0,0,1,1,0,0,1,0,1,0,0,0,0,0,0,0,0,1,0,0,0};  // Muted Lock sequence
bool unlockPulseWidths[num_positive_pulses] = {1,0,0,1,0,0,1,1,0,0,1,0,1,0,0,0,0,0,0,0,0,0,1,0,0};  // Unlock sequence
bool trunkReleasePulseWidths[num_positive_pulses] = {1,0,0,1,0,0,1,1,0,0,1,0,1,0,0,0,0,0,0,0,1,1,0,0,0};  // Trunk release sequence


////////////////////////////////////////////////////////////////////////////
// BANVIE SYSTEM CONTROL FUNCTIONS

void issuePulses(bool pulseWidths[], int pulse_count){
  
  pinMode(banvie_pin, OUTPUT);  // Set the communication pin as an output because we are forcefully driving the line.
  digitalWrite(banvie_pin, LOW);  // Initiate communication by pulling the line LOW

  for (int r = 0; r < num_repeats_per_train; r++){  // Outer loop for repeating pulse trains (mimicks press and hold of a fob key)
    for (int i = 0; i < pulse_count; i++) {  // Inner loop handles a single pulse sequence
      
      // If a bit must be HIGH, assign the long pulse length to the highTime, and if the bit is low, the highTime must be set to low.
      uint16_t highTime = pulseWidths[i] == 1? long_pulse_length_us: short_pulse_length_us;  
      
      // The lowTime is simply the remainder of the time period on the cycle after allocating time for the high portion.
      uint16_t lowTime = pulseWidths[i] == 1? short_pulse_length_us: long_pulse_length_us;

      // HIGH portion
      digitalWrite(banvie_pin, HIGH);
      startTime = micros();  
      while ((micros() - startTime) < highTime){};
      

      // LOW portion
      digitalWrite(banvie_pin, LOW);
      startTime = micros();
      while ((micros() - startTime) < lowTime){};   
    }
    
    delay(12);  // gap between trains
  }

  // Important: We should set the pin back to a floating state so that an external remote too can shift the logic levels to communicate with the Banvie.
  pinMode(banvie_pin, INPUT);
  
}

////////////////////////////////////////////////////////////////////////////
// METHODS THAT SEND THE APPROPRIATE SEQUENCE PER KEY FOB FUNCTION
void lockCar(){
  Serial.println("Locking car");
  issuePulses(lockPulseWidths, num_positive_pulses);  
}

void mutedLockCar(){
  Serial.println("Muted Lock Activated");
  issuePulses(mutedLockPulseWidths, num_positive_pulses);
}

void unlockCar(){
  Serial.println("Unlocking Car");
  issuePulses(unlockPulseWidths, num_positive_pulses);
}

void releaseTrunk(){
  Serial.println("Releasing Trunk Door");      
  long trunk_start_time = millis();
  while ((millis() - trunk_start_time) < (trunk_release_key_press_hold_time_s * 1000)){
    issuePulses(trunkReleasePulseWidths, num_positive_pulses);
  }      
}

////////////////////////////////////////////////////////////////////////////
// COMPARE THE CHARACTERS RECEIVED VIA SERIAL INPUT TO CALL APPROPRIATE FOB FUNCTION
void handleSerialInputForBanvieSystem(char c){
    
    if (c == 'L') {
      lockCar();
    }
    else if (c == 'T') {          
      releaseTrunk();
    }
    else if (c == 'U') {
      unlockCar();
    }
    else if (c == 'M') {
      mutedLockCar();
    }
}


////////////////////////////////////////////////////////////////////////////
// SETUP THE SYSTEM
void setupBanviewSystem(){
    pinMode(banvie_pin, INPUT); // This should be set to floating whenever we do NOT issue any command so that the normal remote can also work.
    Serial.println("Banvie system initialized.");
    Serial.println("Press 'L', 'T', 'U', 'M' for 'Lock', 'Trunk release', 'Unlock', and 'Muted Lock' respectively.");
}

void setup() {
  Serial.begin(74880);
  setupBanviewSystem();
}


void loop() {
  // Repeatedly poll for characters received via the serial input and call the appropriate fob function 
  if (Serial.available() > 0) {
    char c = Serial.read();
    Serial.println("Received Serial Code " + String(c));
    handleSerialInputForBanvieSystem(c);
  }

  delay(100);

}