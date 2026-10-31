import numpy as np
import pandas as pd
import matplotlib.pyplot as plt


# Load Excel file and convert tp numpy
df = pd.read_excel("key_fob_codes_no_headers.xls")

data = df.to_numpy()

# region Parameters and initial setup
sampling_interval = 50e-6  # 50 microseconds
min_true_pulse_width_n_samples = 3
half_pulse_height = 60
sync_start_index = [400, 400, 400] + [400, 400, 400] + [300, 300, 300] + [300, 300, 300]
max_aligned_len = 1000
n_reps_per_trace = 3
n_trace_types = 4

n_samples = data.shape[0]
n_traces = data.shape[1]

time_vec = np.arange(n_samples) * sampling_interval * 1e3  # In milliseconds

# Assign names and colors to traces
trace_names = ([f'Unlock: rep {i}' for i in range(n_reps_per_trace)] +
               [f'Muted Lock: rep {i}' for i in range(n_reps_per_trace)] +
               [f'Trunk Release: rep {i}' for i in range(n_reps_per_trace)] +
               [f'Lock: rep {i}' for i in range(n_reps_per_trace)])
trace_colors = ['r'] * n_reps_per_trace + ['g'] * n_reps_per_trace + ['b'] * n_reps_per_trace + ['m'] * n_reps_per_trace
# endregion

# region Plot raw data to see what they look like
fig_raws, axs_raws = plt.subplots(n_traces, 1, sharex=True, constrained_layout=True, figsize=(20, 10))
axs_raws[-1].set_xlabel('Time (ms)')
for i, (trace, trace_name, trace_color, ax_aligned) in enumerate(zip(data.T, trace_names, trace_colors, axs_raws)):
    ax_aligned.plot(time_vec, trace, color=trace_color)
    ax_aligned.set_title(trace_name)
# endregion

# region Truncate off partial pulse train that precedes the main, complete pulse train)
fig_truncated, axs_truncated = plt.subplots(n_traces, 1, sharex=True, constrained_layout=True, figsize=(20, 10))
axs_truncated[-1].set_xlabel('Time (ms)')
truncated_data = []
for i, (trace, trace_name, trace_color, ax_truncated,  start_ind) in enumerate(zip(data.T, trace_names, trace_colors, axs_truncated, sync_start_index)):

    truncated_trace = trace[start_ind:]
    truncated_data.append(truncated_trace)
    truncated_time_vec = np.arange(len(truncated_trace)) * sampling_interval * 1e3  # In ms

    ax_truncated.plot(truncated_time_vec, truncated_trace, color=trace_color)
    ax_truncated.set_title(trace_name)
# endregion

# region Find the start index of the first positive edge (that is not noise) of the truncated traces and align all
#   traces at this sample.
fig_aligned, axs_aligned = plt.subplots(n_traces, 1, sharex=True, constrained_layout=True, figsize=(20, 10))
axs_aligned[-1].set_xlabel('Time (ms)')
aligned_traces = []
for i, (trace_name, trace_color, ax_aligned, truncated_trace) in enumerate(zip(trace_names, trace_colors, axs_aligned, truncated_data)):

    positive_pulse_start_inds = np.argwhere(np.diff(truncated_trace) >= half_pulse_height).squeeze()
    positive_pulse_end_inds = np.argwhere(np.diff(truncated_trace) <= -1 * half_pulse_height).squeeze()

    # Handles situations where there are pulses that do not have two edges
    if positive_pulse_end_inds[0] < positive_pulse_start_inds[0]:
        positive_pulse_end_inds = positive_pulse_end_inds[1:]
    if positive_pulse_start_inds[-1] > positive_pulse_end_inds[-1]:
        positive_pulse_start_inds = positive_pulse_start_inds[:-1]

    positive_pulse_widths = positive_pulse_end_inds - positive_pulse_start_inds
    true_first_pulse_start_ind = positive_pulse_start_inds[np.argwhere(positive_pulse_widths > min_true_pulse_width_n_samples).squeeze()][0]

    time_aligned_trace = truncated_trace[true_first_pulse_start_ind:max_aligned_len]
    aligned_traces.append(time_aligned_trace)
    time_aligned_time_vec = np.arange(len(time_aligned_trace)) * sampling_interval * 1e3  # In milliseconds

    ax_aligned.plot(time_aligned_time_vec, time_aligned_trace, color=trace_color)
    ax_aligned.set_title(trace_name)

# endregion

# region Overlay all repeats for a given function on top of each other to see if they are similar
fig_overlay, axs_overlay = plt.subplots(n_trace_types + 1, 1, sharex=True, constrained_layout=True, figsize=(20, 10))
axs_overlay[-1].set_xlabel('Time (ms)')
for i, (time_aligned_trace, trace_name, trace_color) in enumerate(zip(aligned_traces, trace_names, trace_colors)):

    time_aligned_time_vec = np.arange(len(time_aligned_trace)) * sampling_interval * 1e3  # In milliseconds

    axs_overlay[int(i / 3)].plot(time_aligned_time_vec, time_aligned_trace, color=trace_color)
    axs_overlay[int(i / 3)].set_title(trace_name.split(':')[0])

    axs_overlay[-1].plot(time_aligned_time_vec, time_aligned_trace, color=trace_color)
    axs_overlay[-1].set_title('All traces overlain')

# endregion

# region Get all pulse widths per key fob function repeat as a sequence.
all_pulse_widths_store = []
cycle_periods_store = []
positive_pulse_width_sequences = [[] for _ in range(n_trace_types)]
for i, (trace_name, aligned_trace) in enumerate(zip(trace_names, aligned_traces)):

    positive_pulse_start_inds = np.argwhere(np.diff(aligned_trace) >= half_pulse_height).squeeze()
    positive_pulse_end_inds = np.argwhere(np.diff(aligned_trace) <= -1 * half_pulse_height).squeeze()

    # Handles situations where there are pulses that do not have two edges
    if positive_pulse_end_inds[0] < positive_pulse_start_inds[0]:
        positive_pulse_end_inds = positive_pulse_end_inds[1:]
    if positive_pulse_start_inds[-1] > positive_pulse_end_inds[-1]:
        positive_pulse_start_inds = positive_pulse_start_inds[:-1]

    positive_pulse_widths = positive_pulse_end_inds - positive_pulse_start_inds
    indices_of_true_positive_pulses_in_positive_pulse_inds = np.argwhere(positive_pulse_widths > min_true_pulse_width_n_samples).squeeze()
    true_positive_pulse_widths = positive_pulse_widths[indices_of_true_positive_pulses_in_positive_pulse_inds] * sampling_interval * 1e6    # In microseconds
    start_indices_of_true_positive_pulses = positive_pulse_start_inds[indices_of_true_positive_pulses_in_positive_pulse_inds]
    cycle_period_sample_counts = np.diff(start_indices_of_true_positive_pulses)
    cycle_periods = cycle_period_sample_counts  * sampling_interval * 1e6  # In microseconds

    num_pulses_per_sequence = len(true_positive_pulse_widths)
    print(f"\n\n{trace_name}: \n Number of pulses (bits) per sequence: {num_pulses_per_sequence}; "
          f"\nPulse widths sequence: {true_positive_pulse_widths};"
          f"\nPulse cycle periods: {cycle_periods}.")

    all_pulse_widths_store = all_pulse_widths_store + true_positive_pulse_widths.tolist()
    cycle_periods_store = cycle_periods_store + cycle_periods.tolist()
    positive_pulse_width_sequences[int(i/n_reps_per_trace)].append(true_positive_pulse_widths.tolist())


# endregion


# region Print the average pulse train per key fob function
print(f"\n======================Average Pulse Widths Sequences Per Fob Function=======================\n")
average_positive_pulse_width_sequence_per_fob_function = np.mean(np.array(positive_pulse_width_sequences), axis=1)
for trace_name, pulse_sequence in zip(trace_names, average_positive_pulse_width_sequence_per_fob_function):
    pulse_sequence_str = str(pulse_sequence.astype(int)).replace('\n', '')
    print(f"{trace_name.split(':')[0]}: {pulse_sequence_str}\n")

print(f"\n=============================================\n")

# endregion



# region Plot the distribution of pulse widths and cycle periods
fig_pulse_widths, axs_pulse_widths = plt.subplots(2, 1, constrained_layout=True, figsize=(20, 10), sharex=True)
axs_pulse_widths[-1].set_xlabel('Time (uS)')

axs_pulse_widths[0].hist(all_pulse_widths_store, bins=50)
axs_pulse_widths[0].set_title('Pulse widths histogram')

axs_pulse_widths[1].hist(cycle_periods_store, bins=50)
axs_pulse_widths[1].set_title('Cycle periods histograms')
# endregion


plt.show()


